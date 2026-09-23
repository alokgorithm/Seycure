package com.arkqube.seycure;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * Play Billing for the one-time Pro unlock.
 *
 * The Play Billing Library is used directly, with no third-party wrapper. Per
 * CLAUDE.md §6.6 a service like RevenueCat would receive device identifiers
 * and purchase data, which would have to be declared in Data Safety and
 * contradicts the app's pitch. Play already ties the purchase to the user's
 * Google account plus our package name, which is the whole of the identity
 * system here - there is no login, no account and no server.
 *
 * Two rules matter more than the rest.
 *
 * Acknowledgement. Google auto-refunds and revokes any purchase not
 * acknowledged within 72 hours, and it is the commonest billing bug in a
 * first app. Acknowledgement happens here, in native code, the moment a
 * purchase is seen in PURCHASED state - both from the purchase flow and from
 * every queryPurchases() sweep, so a purchase that arrived while the app was
 * closed is acknowledged on the next launch. Nothing waits on the web layer:
 * if the WebView never gets the message, or the entitlement fails to persist,
 * the acknowledgement has already happened and the next sweep re-derives the
 * entitlement from Play anyway. The cache can be lost; the acknowledgement
 * cannot.
 *
 * Ownership. Play is the source of truth and this plugin never stores
 * anything. It reports what Play says right now; the TypeScript layer caches
 * that for offline use and re-verifies on resume, so a refund re-locks.
 */
@CapacitorPlugin(name = "Billing")
public class BillingPlugin extends Plugin implements PurchasesUpdatedListener {

    /** Must match the in-app product id configured in Play Console. */
    public static final String PRO_PRODUCT_ID = "seycure_pro";

    private BillingClient billingClient;

    /**
     * The call awaiting the result of a purchase flow.
     *
     * onPurchasesUpdated arrives asynchronously after the Play sheet closes,
     * so the call is held here rather than resolved when the sheet opens.
     */
    private PluginCall pendingPurchaseCall;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
                .setListener(this)
                .enablePendingPurchases(
                        PendingPurchasesParams.newBuilder()
                                .enableOneTimeProducts()
                                .build())
                .build();
    }

    @Override
    protected void handleOnDestroy() {
        if (billingClient != null && billingClient.isReady()) {
            billingClient.endConnection();
        }
        super.handleOnDestroy();
    }

    // ── Connection ──────────────────────────────────────────────────────────

    private interface Connected {
        void run();
        void failed(BillingResult result);
    }

    /**
     * Runs work once the billing service is connected.
     *
     * The connection drops on its own - Play updating itself is enough to do
     * it - so every entry point goes through here rather than assuming a
     * connection made earlier is still alive.
     */
    private void withConnection(final Connected work) {
        if (billingClient.isReady()) {
            work.run();
            return;
        }

        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    work.run();
                } else {
                    work.failed(result);
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Nothing to do: the next call reconnects. Retrying in a loop
                // here would fight the user's device rather than help it.
            }
        });
    }

    /**
     * Maps a billing response to a stable code the UI can branch on.
     *
     * The UI must not match on message strings - they are localised and they
     * change - so every state the product cares about gets a name here.
     */
    private static String codeFor(BillingResult result) {
        switch (result.getResponseCode()) {
            case BillingClient.BillingResponseCode.OK:
                return "OK";
            case BillingClient.BillingResponseCode.USER_CANCELED:
                return "USER_CANCELLED";
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED:
            case BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE:
            case BillingClient.BillingResponseCode.NETWORK_ERROR:
                return "NETWORK_UNAVAILABLE";
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE:
                // Play Store missing, signed out, or too old to talk to.
                return "BILLING_UNAVAILABLE";
            case BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED:
                return "NOT_SUPPORTED";
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED:
                return "ALREADY_OWNED";
            case BillingClient.BillingResponseCode.ITEM_UNAVAILABLE:
                return "ITEM_UNAVAILABLE";
            case BillingClient.BillingResponseCode.DEVELOPER_ERROR:
                return "DEVELOPER_ERROR";
            default:
                return "ERROR";
        }
    }

    /**
     * A failure carrying a code the UI can branch on.
     *
     * codeFor() is clamped away from "OK" here on purpose. Play answers a
     * product-details query for an id it does not recognise with responseCode
     * OK and an empty list, so deriving the code from the response alone
     * produced { ok: false, code: "OK" } - and the UI, which reads the code,
     * told the user "Pro unlocked. Thank you." after a purchase that could
     * not possibly have happened. A failure is never OK.
     */
    private static JSObject failure(BillingResult result) {
        String code = codeFor(result);
        if ("OK".equals(code)) code = "ERROR";
        return failure(code);
    }

    private static JSObject failure(String code) {
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("code", code);
        out.put("owned", false);
        return out;
    }

    // ── Acknowledgement ─────────────────────────────────────────────────────

    /**
     * Acknowledges a purchase if it has not been acknowledged already.
     *
     * Deliberately fire-and-forget: the caller's entitlement answer does not
     * wait on it, because an acknowledgement that fails now will be retried by
     * the next sweep, and Play has 72 hours before it acts. Blocking the unlock
     * on it would make a working purchase look broken over a slow network.
     */
    private void acknowledgeIfNeeded(Purchase purchase) {
        if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) return;
        if (purchase.isAcknowledged()) return;

        AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchase.getPurchaseToken())
                .build();

        billingClient.acknowledgePurchase(params, result -> {
            // Nothing to report. A failure here leaves the purchase
            // unacknowledged, and the next queryPurchases() - on the next
            // launch or resume - sees isAcknowledged() false and tries again.
        });
    }

    /**
     * True when this purchase entitles the user to Pro right now.
     *
     * PENDING is not ownership: the money has not moved, and treating it as
     * owned would hand out Pro for a payment that may never complete.
     */
    private boolean grantsPro(Purchase purchase) {
        return purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED
                && purchase.getProducts().contains(PRO_PRODUCT_ID);
    }

    // ── Purchase flow results ───────────────────────────────────────────────

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, List<Purchase> purchases) {
        PluginCall call = pendingPurchaseCall;
        pendingPurchaseCall = null;

        boolean owned = false;
        if (purchases != null) {
            for (Purchase purchase : purchases) {
                // Acknowledge regardless of whether anyone is listening: this
                // callback also fires for a purchase completed outside the app.
                acknowledgeIfNeeded(purchase);
                if (grantsPro(purchase)) owned = true;
            }
        }

        if (call == null) return;

        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK) {
            JSObject out = new JSObject();
            out.put("ok", true);
            out.put("code", owned ? "OK" : "NO_PURCHASE");
            out.put("owned", owned);
            call.resolve(out);
            return;
        }

        // ITEM_ALREADY_OWNED is a success for a non-consumable: the user has
        // it, they just bought it on another device or before a reinstall. The
        // sweep that follows will confirm and acknowledge it.
        if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            JSObject out = new JSObject();
            out.put("ok", true);
            out.put("code", "ALREADY_OWNED");
            out.put("owned", true);
            call.resolve(out);
            return;
        }

        call.resolve(failure(result));
    }

    // ── Plugin API ──────────────────────────────────────────────────────────

    /**
     * What Play says about ownership right now.
     *
     * Called on launch and on every resume. Every returned purchase is
     * acknowledged if it needs it, which is what catches a purchase made while
     * the app was closed.
     */
    @PluginMethod
    public void queryPurchases(final PluginCall call) {
        withConnection(new Connected() {
            @Override
            public void run() {
                QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build();

                billingClient.queryPurchasesAsync(params, (result, purchases) -> {
                    if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        call.resolve(failure(result));
                        return;
                    }

                    boolean owned = false;
                    for (Purchase purchase : purchases) {
                        acknowledgeIfNeeded(purchase);
                        if (grantsPro(purchase)) owned = true;
                    }

                    JSObject out = new JSObject();
                    out.put("ok", true);
                    out.put("code", "OK");
                    out.put("owned", owned);
                    call.resolve(out);
                });
            }

            @Override
            public void failed(BillingResult result) {
                call.resolve(failure(result));
            }
        });
    }

    /** The localised price, for showing on the paywall. */
    @PluginMethod
    public void getProductDetails(final PluginCall call) {
        withConnection(new Connected() {
            @Override
            public void run() {
                QueryProductDetailsParams.Product product =
                        QueryProductDetailsParams.Product.newBuilder()
                                .setProductId(PRO_PRODUCT_ID)
                                .setProductType(BillingClient.ProductType.INAPP)
                                .build();

                QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                        .setProductList(java.util.Collections.singletonList(product))
                        .build();

                billingClient.queryProductDetailsAsync(params, (result, productDetailsList) -> {
                    if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        call.resolve(failure(result));
                        return;
                    }
                    // OK with nothing in it means Play does not know this
                    // product id for this package - not yet configured, or not
                    // available in this country or on this account.
                    if (productDetailsList == null || productDetailsList.isEmpty()) {
                        call.resolve(failure("ITEM_UNAVAILABLE"));
                        return;
                    }

                    ProductDetails details = productDetailsList.get(0);
                    ProductDetails.OneTimePurchaseOfferDetails offer =
                            details.getOneTimePurchaseOfferDetails();

                    JSObject out = new JSObject();
                    out.put("ok", true);
                    out.put("code", "OK");
                    out.put("owned", false);
                    out.put("price", offer != null ? offer.getFormattedPrice() : null);
                    call.resolve(out);
                });
            }

            @Override
            public void failed(BillingResult result) {
                call.resolve(failure(result));
            }
        });
    }

    /** Opens Play's purchase sheet. Resolves once the flow reports back. */
    @PluginMethod
    public void purchase(final PluginCall call) {
        withConnection(new Connected() {
            @Override
            public void run() {
                QueryProductDetailsParams.Product product =
                        QueryProductDetailsParams.Product.newBuilder()
                                .setProductId(PRO_PRODUCT_ID)
                                .setProductType(BillingClient.ProductType.INAPP)
                                .build();

                QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                        .setProductList(java.util.Collections.singletonList(product))
                        .build();

                billingClient.queryProductDetailsAsync(params, (result, productDetailsList) -> {
                    if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        call.resolve(failure(result));
                        return;
                    }
                    if (productDetailsList == null || productDetailsList.isEmpty()) {
                        call.resolve(failure("ITEM_UNAVAILABLE"));
                        return;
                    }

                    BillingFlowParams.ProductDetailsParams selected =
                            BillingFlowParams.ProductDetailsParams.newBuilder()
                                    .setProductDetails(productDetailsList.get(0))
                                    .build();

                    BillingFlowParams flow = BillingFlowParams.newBuilder()
                            .setProductDetailsParamsList(
                                    java.util.Collections.singletonList(selected))
                            .build();

                    // Held so onPurchasesUpdated can resolve it; the sheet
                    // opening is not the result.
                    pendingPurchaseCall = call;

                    BillingResult launch =
                            billingClient.launchBillingFlow(getActivity(), flow);

                    if (launch.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        pendingPurchaseCall = null;
                        call.resolve(failure(launch));
                    }
                });
            }

            @Override
            public void failed(BillingResult result) {
                call.resolve(failure(result));
            }
        });
    }
}
