package com.arkqube.clrlink;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MLKitTextPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
