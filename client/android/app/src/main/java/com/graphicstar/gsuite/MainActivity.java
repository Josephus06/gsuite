package com.graphicstar.gsuite;

import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * T1S runs the live web app inside the WebView (capacitor.config.json server.url). A WebView
 * does not do three things a browser does, and the web app leans on all of them:
 *  - downloads: Excel extracts and the like are built as blob: URLs and "clicked"; a WebView
 *    silently drops those. The shim below hands the blob's bytes to saveFile(), which writes
 *    them to the phone's Downloads folder.
 *  - window.print(): a no-op in a WebView. It is routed to Android's print dialog, which also
 *    offers Save as PDF.
 *  - the back button: without this it closes the app instead of going back a page.
 */
public class MainActivity extends BridgeActivity {

    // Injected on every page load. Wraps anchor clicks that carry a download attribute and
    // window.print(); everything else in the page is untouched.
    private static final String SHIM =
        "(function(){if(window.__t1sShim)return;window.__t1sShim=true;" +
        "var A=window.T1SAndroid;if(!A)return;" +
        "function save(blob,name){var r=new FileReader();r.onload=function(){" +
        "var s=String(r.result);A.saveFile(s.slice(s.indexOf(',')+1),name||'download',blob.type||'application/octet-stream');};" +
        "r.readAsDataURL(blob);}" +
        "var click=HTMLAnchorElement.prototype.click;" +
        "HTMLAnchorElement.prototype.click=function(){var h=this.href||'';" +
        "if(this.hasAttribute('download')&&(h.indexOf('blob:')===0||h.indexOf('data:')===0)){" +
        "var n=this.getAttribute('download');fetch(h).then(function(x){return x.blob();}).then(function(b){save(b,n);})" +
        ".catch(function(e){A.toast('Download failed: '+e);});return;}" +
        "return click.apply(this,arguments);};" +
        "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[download]');" +
        "if(!a)return;var h=a.href||'';if(h.indexOf('blob:')===0||h.indexOf('data:')===0){e.preventDefault();a.click();}},true);" +
        "window.print=function(){A.print(document.title||'T1S');};" +
        "})();";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = bridge.getWebView();
        webView.addJavascriptInterface(new NativeBridge(), "T1SAndroid");

        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                view.evaluateJavascript(SHIM, null);
            }
        });

        // A plain link to a file (not a blob) goes through the system download manager, carrying
        // the session cookies the WebView has for that host.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            if (!url.startsWith("http")) return;
            try {
                String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setMimeType(mimeType);
                req.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                req.addRequestHeader("User-Agent", userAgent);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
                toast("Downloading " + name);
            } catch (Exception e) {
                toast("Download failed: " + e.getMessage());
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = bridge.getWebView();
                if (wv.canGoBack()) wv.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
    }

    private class NativeBridge {

        @JavascriptInterface
        public void saveFile(String base64, String fileName, String mimeType) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String name = fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new IllegalStateException("could not create the file");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        out.write(bytes);
                    }
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    dir.mkdirs();
                    try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                        out.write(bytes);
                    }
                }
                toast("Saved to Downloads: " + name);
            } catch (Exception e) {
                toast("Download failed: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void print(String title) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = bridge.getWebView().createPrintDocumentAdapter(title);
                pm.print(title, adapter, new PrintAttributes.Builder().build());
            });
        }

        @JavascriptInterface
        public void toast(String msg) {
            MainActivity.this.toast(msg);
        }
    }
}
