package com.arkqube.seycure;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MLKitTextPlugin.class);
        registerPlugin(AppSettingsPlugin.class);
        registerPlugin(PdfUnlockPlugin.class);

        // PDFBox loads its fonts and CMaps from assets and needs the context
        // before any document is opened. Cheap, and it only touches local
        // resources, so it is fine on the main thread here.
        PDFBoxResourceLoader.init(getApplicationContext());

        super.onCreate(savedInstanceState);
    }
}
