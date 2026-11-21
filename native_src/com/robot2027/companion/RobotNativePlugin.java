package com.robot2027.companion;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.text.format.Formatter;
import android.view.View;
import android.view.WindowManager;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Locale;

@CapacitorPlugin(name = "RobotNative")
public class RobotNativePlugin extends Plugin {

    public static volatile boolean sKioskLocked = false;

    private TextToSpeech tts;
    private SpeechRecognizer speechRecognizer;
    private boolean isListening = false;
    private int listenSessionId = 0;
    private int savedNotifVol = -1;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        mainHandler.post(() -> {
            initTTS();
            if (getActivity() != null) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            if (sKioskLocked) {
                applyKioskFlags(getActivity(), true);
            }
        });
    }

    public static void reapplyKioskIfLocked(Activity activity) {
        if (activity != null && sKioskLocked) {
            applyKioskFlags(activity, true);
        }
    }

    private void initTTS() {
        tts = new TextToSpeech(getContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.US);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                        JSObject data = new JSObject();
                        data.put("id", utteranceId);
                        notifyListeners("ttsStart", data);
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        JSObject data = new JSObject();
                        data.put("id", utteranceId);
                        notifyListeners("ttsEnd", data);
                    }

                    @Override
                    public void onError(String utteranceId) {
                        JSObject data = new JSObject();
                        data.put("id", utteranceId);
                        notifyListeners("ttsEnd", data);
                    }
                });
            }
        });
    }

    public static void applyKioskFlags(Activity activity, boolean enable) {
        if (activity == null) return;
        activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        View decorView = activity.getWindow().getDecorView();

        if (enable) {
            decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
            try {
                ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                if (am != null && am.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_NONE) {
                    activity.startLockTask();
                }
            } catch (Exception ignored) {}
        } else {
            try {
                activity.stopLockTask();
            } catch (Exception ignored) {}
            decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    @PluginMethod
    public void requestAllPermissions(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        ArrayList<String> perms = new ArrayList<>();
        perms.add(Manifest.permission.RECORD_AUDIO);
        perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
        perms.add(Manifest.permission.ACCESS_COARSE_LOCATION);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms.add(Manifest.permission.BLUETOOTH_CONNECT);
            perms.add(Manifest.permission.BLUETOOTH_SCAN);
        }

        ActivityCompat.requestPermissions(activity, perms.toArray(new String[0]), 2027);
        call.resolve();
    }

    @PluginMethod
    public void getDeviceStatus(PluginCall call) {
        Context ctx = getContext();
        IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryStatus = ctx.registerReceiver(null, ifilter);

        int level = 100;
        float temp = 36.5f;
        boolean isCharging = false;

        if (batteryStatus != null) {
            int rawLevel = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (rawLevel >= 0 && scale > 0) {
                level = Math.round((rawLevel * 100f) / scale);
            }
            int rawTemp = batteryStatus.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 365);
            temp = rawTemp / 10.0f;
            int status = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                         status == BatteryManager.BATTERY_STATUS_FULL;
        }

        String wifiSsid = "Chưa kết nối Wi-Fi";
        String localIp = "0.0.0.0";
        try {
            WifiManager wifiManager = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null && wifiManager.isWifiEnabled()) {
                WifiInfo info = wifiManager.getConnectionInfo();
                if (info != null) {
                    int ipInt = info.getIpAddress();
                    if (ipInt != 0) {
                        localIp = Formatter.formatIpAddress(ipInt);
                    }
                    String rawSsid = info.getSSID();
                    if (rawSsid != null) {
                        wifiSsid = rawSsid.replace("\"", "");
                    }
                    if (wifiSsid.isEmpty() || wifiSsid.contains("unknown ssid")) {
                        boolean hasLoc = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                            == PackageManager.PERMISSION_GRANTED;
                        wifiSsid = hasLoc ? "Đã kết nối Wi-Fi" : "Đã kết nối (Cần quyền Vị trí)";
                    }
                }
            }
        } catch (Exception e) {
            wifiSsid = "Wi-Fi Sẵn sàng";
        }

        boolean isPinned = false;
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null) {
                isPinned = am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
            }
        } catch (Exception ignored) {}

        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        int volumePct = 80;
        if (am != null) {
            int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            if (max > 0) volumePct = Math.round((cur * 100f) / max);
        }

        JSObject ret = new JSObject();
        ret.put("battery", level);
        ret.put("temperature", temp);
        ret.put("isCharging", isCharging);
        ret.put("wifiSsid", wifiSsid);
        ret.put("localIp", localIp);
        ret.put("isPinned", isPinned);
        ret.put("kioskLocked", sKioskLocked);
        ret.put("volume", volumePct);
        call.resolve(ret);
    }

    @PluginMethod
    public void setBrightness(PluginCall call) {
        int level = call.getInt("level", 70);
        float val = Math.max(0.02f, Math.min(1.0f, level / 100.0f));
        mainHandler.post(() -> {
            Activity activity = getActivity();
            if (activity != null) {
                WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
                lp.screenBrightness = val;
                activity.getWindow().setAttributes(lp);
            }
            JSObject ret = new JSObject();
            ret.put("level", level);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        int level = Math.max(0, Math.min(100, call.getInt("level", 80)));
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int target = Math.round((level / 100.0f) * max);
            am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0);
        }
        JSObject ret = new JSObject();
        ret.put("level", level);
        call.resolve(ret);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en-US");
        float rate = call.getFloat("rate", 0.95f);
        float pitch = call.getFloat("pitch", 1.08f);

        if (tts == null || text.isEmpty()) {
            call.resolve();
            return;
        }

        mainHandler.post(() -> {
            Locale locale = lang.startsWith("vi") ? new Locale("vi", "VN") : Locale.US;
            tts.setLanguage(locale);
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            Bundle params = new Bundle();
            String uttId = "utt_" + System.currentTimeMillis();
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, uttId);
            call.resolve();
        });
    }

    @PluginMethod
    public void stopSpeak(PluginCall call) {
        if (tts != null) {
            tts.stop();
        }
        call.resolve();
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        String lang = call.getString("lang", "vi-VN");
        mainHandler.post(() -> {
            try {
                final int currentSession = ++listenSessionId;
                muteBeep(true);
                if (speechRecognizer != null) {
                    try {
                        speechRecognizer.cancel();
                        speechRecognizer.destroy();
                    } catch (Exception ignored) {}
                    speechRecognizer = null;
                }
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                speechRecognizer.setRecognitionListener(new RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle params) {
                        if (currentSession != listenSessionId) return;
                        mainHandler.postDelayed(() -> muteBeep(false), 350);
                    }
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float rmsdB) {}
                    @Override public void onBufferReceived(byte[] buffer) {}
                    @Override public void onEndOfSpeech() {
                        if (currentSession == listenSessionId) isListening = false;
                    }
                    @Override public void onError(int error) {
                        if (currentSession != listenSessionId) return;
                        isListening = false;
                        muteBeep(false);
                        JSObject err = new JSObject();
                        err.put("code", error);
                        notifyListeners("speechError", err);
                    }
                    @Override public void onResults(Bundle results) {
                        if (currentSession != listenSessionId) return;
                        isListening = false;
                        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        String best = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                        JSObject res = new JSObject();
                        res.put("text", best);
                        res.put("lang", lang);
                        notifyListeners("speechResult", res);
                    }
                    @Override public void onPartialResults(Bundle partialResults) {
                        if (currentSession != listenSessionId) return;
                        ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (matches != null && !matches.isEmpty()) {
                            JSObject res = new JSObject();
                            res.put("text", matches.get(0));
                            res.put("lang", lang);
                            notifyListeners("speechPartial", res);
                        }
                    }
                    @Override public void onEvent(int eventType, Bundle params) {}
                });

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
                intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, lang.startsWith("en"));
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                isListening = true;
                speechRecognizer.startListening(intent);
                call.resolve();
            } catch (Exception e) {
                muteBeep(false);
                call.reject("Mic error: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        mainHandler.post(() -> {
            listenSessionId++;
            isListening = false;
            if (speechRecognizer != null) {
                try {
                    speechRecognizer.cancel();
                } catch (Exception ignored) {}
            }
            muteBeep(false);
            call.resolve();
        });
    }

    private void muteBeep(boolean mute) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (mute) {
                if (savedNotifVol < 0) {
                    savedNotifVol = am.getStreamVolume(AudioManager.STREAM_NOTIFICATION);
                }
                am.setStreamVolume(AudioManager.STREAM_NOTIFICATION, 0, 0);
            } else if (savedNotifVol >= 0) {
                am.setStreamVolume(AudioManager.STREAM_NOTIFICATION, savedNotifVol, 0);
                savedNotifVol = -1;
            }
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void openWifiSettings(PluginCall call) {
        mainHandler.post(() -> {
            Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? new Intent(Settings.Panel.ACTION_WIFI)
                : new Intent(Settings.ACTION_WIFI_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        });
    }

    @PluginMethod
    public void setKioskMode(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        sKioskLocked = enabled;
        mainHandler.post(() -> {
            applyKioskFlags(getActivity(), enabled);
            mainHandler.postDelayed(() -> {
                boolean isPinned = false;
                try {
                    Activity act = getActivity();
                    if (act != null) {
                        ActivityManager am = (ActivityManager) act.getSystemService(Context.ACTIVITY_SERVICE);
                        if (am != null) {
                            isPinned = am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
                        }
                    }
                } catch (Exception ignored) {}
                JSObject ret = new JSObject();
                ret.put("kioskLocked", sKioskLocked);
                ret.put("isPinned", isPinned);
                call.resolve(ret);
            }, 350);
        });
    }
}
