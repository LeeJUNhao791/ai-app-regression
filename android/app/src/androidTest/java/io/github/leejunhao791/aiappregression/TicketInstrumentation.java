package io.github.leejunhao791.aiappregression;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.TextUtils;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;

public final class TicketInstrumentation extends Instrumentation {
    private Bundle arguments;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments;
        start();
    }

    @Override
    public void onStart() {
        Bundle report = new Bundle();
        try {
            String observed = checkTicket();
            report.putString("stream", "\nTicket UI assertions passed\n" + observed + "\n");
            finish(Activity.RESULT_OK, report);
        } catch (Exception | AssertionError error) {
            report.putString("stream", "\nTicket UI assertion failed: " + error.getMessage() + "\n");
            finish(Activity.RESULT_CANCELED, report);
        }
    }

    private String checkTicket() {
        String ticketId = argument("ticketId");
        String device = argument("expectedDevice");
        String category = argument("expectedCategory");
        Intent intent = new Intent(getTargetContext(), MainActivity.class)
                .putExtra("backendPort", Integer.parseInt(argument("backendPort")))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = startActivitySync(intent);
        try {
            runOnMainSync(() -> {
                EditText input = activity.findViewById(R.id.ticket_input);
                input.setText(ticketId);
                activity.findViewById(R.id.load_ticket).performClick();
            });

            long deadline = SystemClock.elapsedRealtime() + 15_000;
            String[] values = new String[4];
            do {
                runOnMainSync(() -> {
                    values[0] = visibleText(activity, R.id.ticket_id);
                    values[1] = visibleText(activity, R.id.ticket_status);
                    values[2] = visibleText(activity, R.id.ticket_device);
                    values[3] = visibleText(activity, R.id.ticket_category);
                });
                if ("Status: completed".equals(values[1])) break;
                if (values[1].startsWith("Status: Error")) break;
                SystemClock.sleep(100);
            } while (SystemClock.elapsedRealtime() < deadline);

            assertText("Status: completed", values[1]);
            assertText("Ticket ID: " + ticketId, values[0]);
            assertText("Device: " + device, values[2]);
            assertText("Category: " + category, values[3]);
            return TextUtils.join("\n", values);
        } finally {
            runOnMainSync(activity::finish);
        }
    }

    private String argument(String key) {
        String value = arguments.getString(key);
        if (value == null || value.isEmpty()) {
            throw new AssertionError("Missing instrumentation argument " + key);
        }
        return value;
    }

    private static String visibleText(Activity activity, int id) {
        TextView view = activity.findViewById(id);
        return view != null && view.isShown() && view.getWindowVisibility() == View.VISIBLE
                && activity.hasWindowFocus() && view.getGlobalVisibleRect(new Rect())
                ? view.getText().toString() : "<hidden>";
    }

    private static void assertText(String expected, String actual) {
        if (!expected.equals(actual)) {
            throw new AssertionError("Expected [" + expected + "], observed [" + actual + "]");
        }
    }
}
