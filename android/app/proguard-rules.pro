# PdfBox-Android loads fonts, filters and encodings by reflection.
-keep class com.tom_roush.pdfbox.** { *; }
-keep class com.tom_roush.fontbox.** { *; }
-keep class com.tom_roush.harmony.** { *; }
-dontwarn com.gemalto.jp2.**
-dontwarn org.bouncycastle.**

# jsoup optional dependencies
-dontwarn com.google.re2j.**
-dontwarn org.jspecify.annotations.**
