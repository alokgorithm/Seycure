package com.arkqube.clrlink;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import com.google.mlkit.vision.text.Text;

import android.graphics.Rect;

@CapacitorPlugin(name = "MLKitText")
public class MLKitTextPlugin extends Plugin {

    @PluginMethod
    public void analyzeImage(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("No base64 image data provided");
            return;
        }

        try {
            // Decode base64 to Bitmap
            byte[] decodedBytes = Base64.decode(base64, Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.length);

            if (bitmap == null) {
                call.reject("Failed to decode image");
                return;
            }

            // Create InputImage from Bitmap
            InputImage image = InputImage.fromBitmap(bitmap, 0);

            // Get text recognizer
            TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

            // Process the image
            recognizer.process(image)
                    .addOnSuccessListener(text -> {
                        JSObject result = new JSObject();
                        result.put("text", text.getText());

                        JSArray blocks = new JSArray();
                        for (Text.TextBlock block : text.getTextBlocks()) {
                            JSObject blockObj = new JSObject();
                            blockObj.put("text", block.getText());

                            // Bounding box
                            Rect bbox = block.getBoundingBox();
                            if (bbox != null) {
                                JSObject bboxObj = new JSObject();
                                bboxObj.put("x", bbox.left);
                                bboxObj.put("y", bbox.top);
                                bboxObj.put("width", bbox.width());
                                bboxObj.put("height", bbox.height());
                                blockObj.put("bbox", bboxObj);
                            } else {
                                JSObject bboxObj = new JSObject();
                                bboxObj.put("x", 0);
                                bboxObj.put("y", 0);
                                bboxObj.put("width", 0);
                                bboxObj.put("height", 0);
                                blockObj.put("bbox", bboxObj);
                            }

                            blocks.put(blockObj);
                        }

                        result.put("blocks", blocks);
                        call.resolve(result);

                        // Clean up
                        bitmap.recycle();
                    })
                    .addOnFailureListener(e -> {
                        call.reject("ML Kit text recognition failed: " + e.getMessage());
                        bitmap.recycle();
                    });

        } catch (Exception e) {
            call.reject("Error processing image: " + e.getMessage());
        }
    }
}
