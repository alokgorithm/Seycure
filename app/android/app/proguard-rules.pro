# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Capacitor / Cordova — keep WebView bridge classes
-keep class com.getcapacitor.** { *; }
-keep class org.apache.cordova.** { *; }
-dontwarn com.getcapacitor.**
-dontwarn org.apache.cordova.**

# PDFBox (pdfbox-android) references the optional JPEG-2000 codec
# com.gemalto.jp2, which we do not ship: the PDF path only decrypts documents
# and strips metadata, and never decodes image streams. R8 treats the dangling
# reference as a hard error and fails the release build, while the debug build
# passes, so this surfaces only when producing an app bundle.
-dontwarn com.gemalto.jp2.**
