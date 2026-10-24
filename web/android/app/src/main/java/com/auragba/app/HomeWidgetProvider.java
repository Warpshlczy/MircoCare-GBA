package com.auragba.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 2x2 home-screen widget: name + up to 3 pending items + a dedicated SOS hot zone.
 *
 * The payload comes from JS (`native.updateHomeWidget(homeWidgetPayload(...))`)
 * and is cached in SharedPreferences, because the widget must repaint after a
 * process death without waking the WebView.
 *
 * SOS is a separate PendingIntent with its own action: it opens MainActivity with
 * ACTION_SOS, and MainActivity is declared showWhenLocked, so the senior can hit
 * it without unlocking (docs/dev.md §1.8 安全 row 3).
 */
public class HomeWidgetProvider extends AppWidgetProvider {

    static final String PREFS = "memomate_widget";
    static final String KEY_TITLE = "title";
    static final String KEY_ITEMS = "items";
    static final String KEY_UPDATED = "updatedAt";

    private static final int REQUEST_ROOT = 8810;
    private static final int REQUEST_SOS = 8811;

    private static final int[] ROW_IDS = {
            R.id.widget_item_1,
            R.id.widget_item_2,
            R.id.widget_item_3,
    };

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] appWidgetIds) {
        for (int id : appWidgetIds) updateOne(ctx, mgr, id);
    }

    /** Re-renders every placed instance. Safe to call from the plugin/receivers. */
    static void refresh(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        ComponentName cn = new ComponentName(ctx, HomeWidgetProvider.class);
        int[] ids = mgr.getAppWidgetIds(cn);
        for (int id : ids) updateOne(ctx, mgr, id);
    }

    private static void updateOne(Context ctx, AppWidgetManager mgr, int id) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        String title = p.getString(KEY_TITLE, "");
        if (title == null || title.isEmpty()) title = ctx.getString(R.string.app_name); // rename follows strings.xml

        List<String> items = parseItems(p.getString(KEY_ITEMS, "[]"));

        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_home);
        rv.setTextViewText(R.id.widget_title, title);

        for (int i = 0; i < ROW_IDS.length; i++) {
            String text = i < items.size() ? items.get(i) : "";
            if (text.isEmpty()) {
                rv.setViewVisibility(ROW_IDS[i], View.GONE);
            } else {
                rv.setViewVisibility(ROW_IDS[i], View.VISIBLE);
                rv.setTextViewText(ROW_IDS[i], text);
            }
        }

        // Tapping the body opens the assistant as if the widget called it.
        Intent open = new Intent(ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(MainActivity.EXTRA_REASON, "widget");
        rv.setOnClickPendingIntent(R.id.widget_root, activityIntent(ctx, open, REQUEST_ROOT));

        // The SOS hot zone: no unlock required (MainActivity is showWhenLocked).
        Intent sos = new Intent(ctx, MainActivity.class)
                .setAction(MainActivity.ACTION_SOS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(MainActivity.EXTRA_REASON, "widget");
        rv.setOnClickPendingIntent(R.id.widget_sos, activityIntent(ctx, sos, REQUEST_SOS));

        mgr.updateAppWidget(id, rv);
    }

    private static PendingIntent activityIntent(Context ctx, Intent intent, int requestCode) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(ctx, requestCode, intent, flags);
    }

    /** `[{"text":"食药","done":false}, ...]` → display lines with a leading marker. */
    private static List<String> parseItems(String json) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(json == null ? "[]" : json);
            for (int i = 0; i < arr.length() && out.size() < ROW_IDS.length; i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String text = o.optString("text", "");
                if (text.isEmpty()) continue;
                out.add((o.optBoolean("done", false) ? "✓ " : "· ") + text);
            }
        } catch (JSONException ignored) {
            // A malformed payload must not break the widget — show an empty list.
        }
        return out;
    }
}
