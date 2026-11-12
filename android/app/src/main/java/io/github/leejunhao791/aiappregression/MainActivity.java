package io.github.leejunhao791.aiappregression;

import android.app.Activity;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private EditText ticketInput;
    private Button loadButton;
    private String emptyValue;
    private int backendPort;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        View content = getLayoutInflater().inflate(R.layout.ticket, null);
        if (Build.VERSION.SDK_INT >= 35) {
            content.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                Insets insets = windowInsets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(content);
        backendPort = getIntent().getIntExtra("backendPort", 8000);
        emptyValue = getString(R.string.empty_value);
        ticketInput = findViewById(R.id.ticket_input);
        loadButton = findViewById(R.id.load_ticket);
        loadButton.setOnClickListener(view -> loadTicket());
        render(emptyValue, emptyValue, emptyValue, emptyValue);
    }

    private void loadTicket() {
        String id = ticketInput.getText().toString().trim();
        if (id.isEmpty()) {
            ticketInput.setError(getString(R.string.enter_ticket_id));
            return;
        }
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(ticketInput.getWindowToken(), 0);
        loadButton.setEnabled(false);
        render(emptyValue, getString(R.string.loading), emptyValue, emptyValue);
        new Thread(() -> {
            try {
                JSONObject ticket = fetchTicket(id);
                JSONObject result = ticket.getJSONObject("result");
                Object deviceValue = result.get("device");
                String device = deviceValue == JSONObject.NULL ? getString(R.string.no_device) : result.getString("device");
                showResult(ticket.getString("id"), ticket.getString("status"), device, result.getString("category"));
            } catch (IOException | JSONException error) {
                showResult(emptyValue, getString(R.string.load_error, error.getMessage()), emptyValue, emptyValue);
            }
        }, "ticket-http").start();
    }

    private JSONObject fetchTicket(String id) throws IOException, JSONException {
        URL url = new URL("http://127.0.0.1:" + backendPort + "/api/tickets/" + Uri.encode(id));
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(5_000);
        connection.setInstanceFollowRedirects(false);
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + status);
            try (InputStreamReader reader = new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)) {
                StringBuilder body = new StringBuilder();
                char[] chunk = new char[4096];
                for (int count; (count = reader.read(chunk)) != -1; ) {
                    body.append(chunk, 0, count);
                }
                return new JSONObject(body.toString());
            }
        } finally {
            connection.disconnect();
        }
    }

    private void showResult(String id, String status, String device, String category) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            render(id, status, device, category);
            loadButton.setEnabled(true);
        });
    }

    private void render(String id, String status, String device, String category) {
        setText(R.id.ticket_id, R.string.ticket_id, id);
        setText(R.id.ticket_status, R.string.ticket_status, status);
        setText(R.id.ticket_device, R.string.ticket_device, device);
        setText(R.id.ticket_category, R.string.ticket_category, category);
    }

    private void setText(int viewId, int format, String value) {
        TextView view = findViewById(viewId);
        view.setText(getString(format, value));
    }
}
