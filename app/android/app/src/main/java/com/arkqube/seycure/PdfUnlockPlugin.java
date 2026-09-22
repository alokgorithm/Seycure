package com.arkqube.seycure;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDDocumentInformation;
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException;

import java.io.ByteArrayOutputStream;

/**
 * Removing the password from a PDF the user already has the password for.
 *
 * pdf-lib, which the rest of the PDF path uses, cannot do this: it opens an
 * encrypted file with `ignoreEncryption` but has no decryption implementation
 * at all, so saving one back out produces a broken document. PDFBox does
 * implement the standard security handlers, so decryption happens here in
 * native code and the file never leaves the device.
 *
 * Scope is deliberately narrow. The caller supplies a password; a wrong one
 * comes back as WRONG_PASSWORD and nothing else happens. There is no guessing,
 * no wordlist, no attempt to strip an owner password we were not given - that
 * is circumvention rather than convenience, and it is not what this is for.
 */
@CapacitorPlugin(name = "PdfUnlock")
public class PdfUnlockPlugin extends Plugin {

    /**
     * Decoded PDFs are held in memory twice over (bytes in, bytes out), on top
     * of the base64 the bridge already copied. A cap keeps a large scan from
     * taking the app out with an OutOfMemoryError; 25 MB is far above any
     * statement or payslip someone would be scrubbing.
     */
    private static final int MAX_PDF_BYTES = 25 * 1024 * 1024;

    /** Reports whether a file needs a password, so the UI can ask only when it must. */
    @PluginMethod
    public void isEncrypted(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("No PDF data provided");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("PDF data was not valid base64");
            return;
        }

        JSObject result = new JSObject();

        // An encrypted document throws on load with an empty password, which is
        // the cheapest reliable test available.
        PDDocument document = null;
        try {
            document = PDDocument.load(bytes, "");
            result.put("encrypted", document.isEncrypted());
            call.resolve(result);
        } catch (InvalidPasswordException e) {
            result.put("encrypted", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the PDF: " + e.getMessage());
        } finally {
            closeQuietly(document);
        }
    }

    /**
     * Opens the document with the supplied password, drops the encryption and
     * the document information, and hands back the result as base64.
     *
     * Metadata is cleared here rather than left to the existing pdf-lib pass:
     * once this method has produced a decrypted copy, that copy is what gets
     * scrubbed and shared, and doing both in one place means the decrypted
     * bytes are never written anywhere in between.
     */
    @PluginMethod
    public void unlock(PluginCall call) {
        String base64 = call.getString("base64");
        String password = call.getString("password");

        if (base64 == null || base64.isEmpty()) {
            call.reject("No PDF data provided");
            return;
        }
        if (password == null) {
            call.reject("No password provided");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("PDF data was not valid base64");
            return;
        }

        if (bytes.length > MAX_PDF_BYTES) {
            JSObject tooBig = new JSObject();
            tooBig.put("code", "TOO_LARGE");
            call.reject("PDF is too large to unlock on device", "TOO_LARGE", null, tooBig);
            return;
        }

        PDDocument document = null;
        try {
            document = PDDocument.load(bytes, password);

            // Without this the save writes the encryption dictionary straight
            // back out and the copy is still locked.
            document.setAllSecurityToBeRemoved(true);

            document.setDocumentInformation(new PDDocumentInformation());
            document.getDocumentCatalog().setMetadata(null);

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            document.save(out);

            JSObject result = new JSObject();
            result.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (InvalidPasswordException e) {
            // The one failure the user can do something about, so it gets its
            // own code rather than arriving as a generic error.
            JSObject data = new JSObject();
            data.put("code", "WRONG_PASSWORD");
            call.reject("That password did not open the PDF", "WRONG_PASSWORD", null, data);
        } catch (OutOfMemoryError e) {
            JSObject data = new JSObject();
            data.put("code", "TOO_LARGE");
            call.reject("Ran out of memory unlocking this PDF", "TOO_LARGE", null, data);
        } catch (Exception e) {
            call.reject("Could not unlock the PDF: " + e.getMessage());
        } finally {
            closeQuietly(document);
        }
    }

    private void closeQuietly(PDDocument document) {
        if (document == null) return;
        try {
            document.close();
        } catch (Exception ignored) {
            // Nothing useful to do; the caller already has its answer.
        }
    }
}
