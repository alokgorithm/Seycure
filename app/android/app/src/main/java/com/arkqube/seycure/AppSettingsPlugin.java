package com.arkqube.seycure;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens this app's own page in Android Settings.
 *
 * Once camera permission has been denied the WebView cannot prompt again, so
 * the settings page is the only route back and telling the user to find it
 * themselves is a dead end. Capacitor has no API for this and it is a dozen
 * lines of native, so it lives here rather than justifying a new dependency.
 */
@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            // Started from a plugin context rather than an Activity, so this
            // flag is required or the launch throws.
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open app settings", e);
        }
    }
}
