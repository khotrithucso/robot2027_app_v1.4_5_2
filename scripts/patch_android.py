import pathlib
import shutil
import re

def main():
    pkg_dst = pathlib.Path("android/app/src/main/java/com/robot2027/companion")
    pkg_dst.mkdir(parents=True, exist_ok=True)

    src_dir = pathlib.Path("native_src/com/robot2027/companion")
    for java_file in ["RobotNativePlugin.java", "MainActivity.java"]:
        shutil.copy2(src_dir / java_file, pkg_dst / java_file)
        print(f"[OK] Copied {java_file}")

    manifest_path = pathlib.Path("android/app/src/main/AndroidManifest.xml")
    txt = manifest_path.read_text(encoding="utf-8")

    perm_lines = [
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
        '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />',
        '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
        '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
        '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
        '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
        '<uses-permission android:name="android.permission.BLUETOOTH" />',
        '<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />',
        '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
        '<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />',
        '<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />',
    ]
    missing_perms = [p for p in perm_lines if p not in txt]
    if "<queries>" not in txt:
        missing_perms.append(
            '<queries><intent><action android:name="android.speech.RecognitionService" /></intent>'
            '<intent><action android:name="android.intent.action.TTS_SERVICE" /></intent></queries>'
        )
    if missing_perms:
        perms_block = "\n    " + "\n    ".join(missing_perms) + "\n"
        txt = txt.replace("<application", perms_block + "\n    <application", 1)

    if "usesCleartextTraffic" not in txt:
        txt = txt.replace("<application", '<application android:usesCleartextTraffic="true"', 1)

    if "screenOrientation" not in txt:
        txt = txt.replace(
            'android:name=".MainActivity"',
            'android:name=".MainActivity" android:screenOrientation="sensorLandscape" android:lockTaskMode="normal" android:windowSoftInputMode="adjustResize"',
            1
        )

    manifest_path.write_text(txt, encoding="utf-8")
    print("[OK] Patched AndroidManifest.xml")

    vars_path = pathlib.Path("android/variables.gradle")
    if vars_path.exists():
        vtxt = vars_path.read_text(encoding="utf-8")
        vtxt = re.sub(r"compileSdkVersion\s*=\s*\d+", "compileSdkVersion = 35", vtxt)
        vtxt = re.sub(r"targetSdkVersion\s*=\s*\d+", "targetSdkVersion = 35", vtxt)
        vars_path.write_text(vtxt, encoding="utf-8")
        print("[OK] Patched android/variables.gradle to SDK 35")

if __name__ == "__main__":
    main()
