package com.auragba.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins BEFORE super.onCreate().
        registerPlugin(AuraNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}