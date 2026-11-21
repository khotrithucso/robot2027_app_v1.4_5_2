/* ==========================================================================
   ROBOT 2027 - V1.4 PRO
   - Dynamic Unlimited Topics (> 32) via api.php
   - Family Member Profiles + 20-char permanent UID + Real-time 2s api_point.php
   - 2-Stage Sleep Cycle (10s prompt + 10s battery-save sleep) on Robot tab only
   - Zero-Beep Always-Listening + Echo Guard + 3-Way Wake ("Hello", "Lucky", "Hello Lucky")
   - Smart "Tôi muốn..." Voice Commands (Learning, Lights, Multi-turn Head Servo, Brightness/Volume)
   - Dual Security: 4-digit Parental PIN vs Developer Kiosk Exit Code
   ========================================================================== */

(() => {
  const getRobotNative = () => window.Capacitor?.Plugins?.RobotNative || null;
  const getBleClient = () => window.Capacitor?.Plugins?.BluetoothLe || null;

  const DEFAULT_SERVER_BASE = "https://khotrithucso.io.vn/robot2027_2_4/test1";
  const MASTER_NUMERIC_PIN = "202799";
  const MASTER_TEST_PASS = "robotrobot";
  const DEVELOPER_MASTER_CODE = "DEV2027PRO";

  // BLE UUIDs cho mạch ESP32 Robot
  const BLE_SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
  const BLE_CHAR_TX_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
  const BLE_CHAR_RX_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a9";

  // Helper sinh UID 20 ký tự vĩnh viễn cho từng thành viên
  function generateUid20() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let out = "RB";
    for (let i = 0; i < 18; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  // Trạng thái toàn cục
  const state = {
    activeTab: "robot",
    settingsUnlocked: false,
    pendingTab: null,
    isSpeaking: false,
    isListening: false,
    isRecordingLesson: false,
    sleepStage: "awake", // awake | prompting | sleeping
    idleSeconds: 0,
    studySeconds: 0,
    lastHealthPromptAt: 0,
    roleName: "Cô giáo tiếng Anh",
    headLightOn: false,
    armLightOn: false,
    bleDeviceId: null,
    bleConnected: false,
    pointPollTimer: null,
    idleTimer: null,
    audioPlayer: new Audio(),
    lastRecordedBlobUrl: null,
    mediaRecorder: null,
    recordedChunks: [],
    camStream: null,

    // Dữ liệu cấu hình & thành viên lưu localStorage
    config: {
      baseUrl: DEFAULT_SERVER_BASE,
      parentPin: "1234",
      studyOnly: false,
      bedtime: "21:30",
      brightness: 75,
      volume: 80,
      speechRate: 0.95
    },
    members: [],
    activeMemberId: null,

    // Dữ liệu học tập
    topics: [],
    currentTopic: "daily",
    currentTopicTitle: "Giao tiếp hằng ngày",
    sentences: [
      {
        id: 0,
        en: "Hello! How are you today?",
        vi: "Xin chào! Hôm nay bạn khỏe không?",
        audio_url: "",
        spelling: [
          { word: "Hello", spell: "H-E-L-L-O" },
          { word: "How", spell: "H-O-W" },
          { word: "are", spell: "A-R-E" },
          { word: "you", spell: "Y-O-U" },
          { word: "today", spell: "T-O-D-A-Y" }
        ]
      }
    ],
    sentenceIndex: 0
  };

  // ==================== STORAGE & MEMBERS ====================
  function loadLocalState() {
    try {
      const savedCfg = JSON.parse(localStorage.getItem("rb_v14_config") || "null");
      if (savedCfg) {
        if (savedCfg.baseUrl && savedCfg.baseUrl.replace(/\/+$/, "") === "https://khotrithucso.io.vn/robot2027_2_4") {
          savedCfg.baseUrl = DEFAULT_SERVER_BASE;
        }
        Object.assign(state.config, savedCfg);
      }

      const savedMembers = JSON.parse(localStorage.getItem("rb_v14_members") || "null");
      if (Array.isArray(savedMembers) && savedMembers.length > 0) {
        state.members = savedMembers;
      } else {
        state.members = [
          { id: "m_default", uid: generateUid20(), name: "Bé Yêu", age: 7, avatar: "🧒", stars: 5 }
        ];
      }

      const activeId = localStorage.getItem("rb_v14_active_member");
      state.activeMemberId = state.members.some(m => m.id === activeId)
        ? activeId
        : state.members[0].id;

      const cachedTopics = JSON.parse(localStorage.getItem("rb_v14_topics") || "null");
      if (Array.isArray(cachedTopics)) state.topics = cachedTopics;
    } catch (e) {
      console.warn("Storage load fallback:", e);
    }
    saveLocalState();
  }

  function saveLocalState() {
    localStorage.setItem("rb_v14_config", JSON.stringify(state.config));
    localStorage.setItem("rb_v14_members", JSON.stringify(state.members));
    localStorage.setItem("rb_v14_active_member", state.activeMemberId);
  }

  function getActiveMember() {
    return state.members.find(m => m.id === state.activeMemberId) || state.members[0];
  }

  function updateHeaderMemberUI() {
    const m = getActiveMember();
    document.getElementById("hdr-member-avatar").textContent = m.avatar || "🧒";
    document.getElementById("hdr-member-name").textContent = m.name;
    document.getElementById("hdr-stars").textContent = m.stars;
    const hardName = document.getElementById("hard-member-name");
    if (hardName) hardName.textContent = m.name;
  }

  function addStarsToActiveMember(delta, reason = "") {
    const m = getActiveMember();
    m.stars = Math.max(0, (parseInt(m.stars, 10) || 0) + delta);
    saveLocalState();
    updateHeaderMemberUI();

    if (delta > 0) {
      setRobotMood("proud");
      sendBleCommand("M:CLAP");
      setTimeout(() => {
        if (state.sleepStage === "awake") setRobotMood("happy");
      }, 2200);
    }
    if (reason) logActivityToServer("STARS_CHANGE", `${delta > 0 ? "+" : ""}${delta}★ (${reason})`);
  }

  // ==================== API ENDPOINTS HELPER ====================
  function apiUrl(file, params = {}) {
    const base = state.config.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/${file}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    return url.toString();
  }

  async function syncMemberProfileServer(member) {
    try {
      await fetch(apiUrl("api_user.php", { action: "sync_profile", bot_id: member.uid }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_profile",
          bot_id: member.uid,
          profile: {
            robot_name: "Lucky",
            learner_name: member.name,
            learner_age: member.age,
            study_only: state.config.studyOnly,
            parent_pin: state.config.parentPin,
            speech_rate: state.config.speechRate,
            brightness: state.config.brightness,
            volume: state.config.volume,
            bedtime_start: state.config.bedtime
          }
        })
      });
    } catch (_) {}
  }

  async function logActivityToServer(type, detail) {
    const m = getActiveMember();
    try {
      await fetch(apiUrl("api_user.php", { action: "log_activity", bot_id: m.uid }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "log_activity", bot_id: m.uid, type, detail })
      });
    } catch (_) {}
  }

  // ==================== 2-SECOND STAR POLLING (YOUTUBE & GAME) ====================
  function startPointPolling() {
    stopPointPolling();
    state.pointPollTimer = setInterval(async () => {
      const m = getActiveMember();
      try {
        const res = await fetch(apiUrl("api_point.php", { uid: m.uid, t: Date.now() }));
        if (!res.ok) return;
        const data = await res.json();
        const remoteStars = data.stars ?? data.points ?? data.data?.stars;
        if (typeof remoteStars === "number" && !Number.isNaN(remoteStars)) {
          if (remoteStars !== m.stars) {
            const diff = remoteStars - m.stars;
            m.stars = Math.max(0, remoteStars);
            saveLocalState();
            updateHeaderMemberUI();
            if (diff > 0) sendBleCommand("M:HAPPY");
          }
        }
      } catch (_) {}
    }, 2000);
  }

  function stopPointPolling() {
    if (state.pointPollTimer) {
      clearInterval(state.pointPollTimer);
      state.pointPollTimer = null;
    }
  }

  // ==================== TAB NAVIGATION & IFRAME LIFECYCLE ====================
  function switchTab(tabName) {
    if ((tabName === "youtube" || tabName === "game") && state.config.studyOnly) {
      speakFeedback("Chế độ Chỉ Học Tập đang bật. Phụ huynh cần mở khóa trong Cài đặt nhé!", "vi-VN");
      return;
    }

    if (tabName === "settings" && !state.settingsUnlocked) {
      state.pendingTab = "settings";
      openPinModal();
      return;
    }

    // Rời tab Robot -> ngắt TTS & Mic để không chồng âm thanh
    if (state.activeTab === "robot" && tabName !== "robot") {
      stopAllSpeechAndMic();
    }

    // Rời YouTube/Game -> giải phóng iframe & dừng polling 2s
    if (state.activeTab === "youtube" && tabName !== "youtube") {
      document.getElementById("frame-youtube").src = "about:blank";
      stopPointPolling();
    }
    if (state.activeTab === "game" && tabName !== "game") {
      document.getElementById("frame-game").src = "about:blank";
      stopPointPolling();
    }

    state.activeTab = tabName;

    document.querySelectorAll(".tab-view").forEach(el => el.classList.remove("active"));
    const targetView = document.getElementById(`tab-${tabName}`);
    if (targetView) targetView.classList.add("active");

    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    // Nút Refresh 🔄 chỉ hiện khi ở YouTube hoặc Game
    const refreshBtn = document.getElementById("btn-refresh-frame");
    if (tabName === "youtube" || tabName === "game") {
      refreshBtn.classList.remove("hidden");
    } else {
      refreshBtn.classList.add("hidden");
    }

    const m = getActiveMember();
    if (tabName === "youtube") {
      // Truyền uid & stars hiện có 1 lần duy nhất lúc mở
      const ytUrl = apiUrl("youtube.php", { uid: m.uid, stars: m.stars });
      document.getElementById("frame-youtube").src = ytUrl;
      startPointPolling();
      logActivityToServer("YOUTUBE_OPEN", `Mở YouTube (${m.name})`);
    } else if (tabName === "game") {
      // Truyền uid & stars hiện có 1 lần duy nhất lúc mở
      const gmUrl = apiUrl("games.php", { uid: m.uid, stars: m.stars });
      document.getElementById("frame-game").src = gmUrl;
      startPointPolling();
      logActivityToServer("GAME_OPEN", `Mở Game (${m.name})`);
    } else if (tabName === "topics") {
      loadTopicsList(false);
    } else if (tabName === "robot") {
      wakeRobot(false);
    }
  }

  // ==================== 2-STAGE SLEEP CYCLE (10S + 10S) & WAKE ====================
  function resetIdleTimer() {
    state.idleSeconds = 0;
    if (state.sleepStage !== "awake") {
      wakeRobot(true);
    }
    updateSleepBadge();
  }

  function updateSleepBadge() {
    const badge = document.getElementById("sleep-countdown-badge");
    if (!badge) return;
    if (state.activeTab !== "robot") {
      badge.textContent = "Giải trí: Không ngủ";
      return;
    }
    if (state.sleepStage === "awake") {
      const rem = Math.max(0, 10 - state.idleSeconds);
      badge.textContent = `Hỏi gợi ý sau: ${rem}s`;
    } else if (state.sleepStage === "prompting") {
      const rem = Math.max(0, 20 - state.idleSeconds);
      badge.textContent = `Tự ngủ sau: ${rem}s`;
    } else {
      badge.textContent = "💤 Đang ngủ tiết kiệm pin";
    }
  }

  function startIdleMonitor() {
    if (state.idleTimer) clearInterval(state.idleTimer);
    state.idleTimer = setInterval(() => {
      // Theo dõi thời gian học liên tục để hỏi thăm sức khỏe (mỗi 12 phút = 720s)
      if (state.activeTab === "robot" && state.sleepStage === "awake") {
        state.studySeconds++;
        if (state.studySeconds - state.lastHealthPromptAt >= 720) {
          state.lastHealthPromptAt = state.studySeconds;
          const m = getActiveMember();
          speakFeedback(
            `${m.name} ơi, mình đã tương tác khá lâu rồi. Bạn có mỏi mắt hay khát nước không? Uống một ngụm nước nhé, hoặc nếu muốn nghỉ giải trí xem YouTube hay chơi game thì nói với mình nha!`,
            "vi-VN"
          );
        }
        checkBedtimeReminder();
      }

      // Chỉ ngủ khi ở tab Robot; không bao giờ ngủ ở YouTube/Game
      if (state.activeTab !== "robot" || state.isSpeaking || state.isRecordingLesson) {
        updateSleepBadge();
        return;
      }

      state.idleSeconds++;
      updateSleepBadge();

      // Giai đoạn 1: Đúng 10s im lặng -> Hỏi gợi ý & liệt kê lựa chọn
      if (state.idleSeconds === 10 && state.sleepStage === "awake") {
        state.sleepStage = "prompting";
        const m = getActiveMember();
        const promptText = `${m.name} ơi, bạn có muốn học tiếng Anh tiếp, đổi chủ đề, ôn từ khó, bật đèn ngủ, xoay đầu, xem YouTube hay chơi game không?`;
        setRobotBubble(promptText);
        speakFeedback(promptText, "vi-VN");
      }

      // Giai đoạn 2: Chờ thêm 10s (tổng 20s) không trả lời -> Ngủ tiết kiệm pin
      if (state.idleSeconds >= 20 && state.sleepStage === "prompting") {
        enterBatterySleepMode();
      }
    }, 1000);
  }

  function enterBatterySleepMode() {
    state.sleepStage = "sleeping";
    setRobotMood("sleeping");
    document.getElementById("sleep-zzz").classList.remove("hidden");
    const voicePill = document.getElementById("hdr-voice-pill");
    voicePill.classList.remove("listening");
    voicePill.classList.add("sleeping");
    document.getElementById("hdr-voice-text").textContent = "Ngủ (Gọi Lucky)";
    setRobotBubble("💤 Lucky đang ngủ tiết kiệm pin... Gọi 'Hello', 'Lucky' hoặc chạm màn hình để đánh thức!");
    if (getRobotNative()) {
      getRobotNative().setBrightness({ level: 5 }).catch(() => {});
    }
    sendBleCommand("M:SLEEP");
    ensureAlwaysListening();
  }

  function wakeRobot(announce = true) {
    const wasSleeping = state.sleepStage === "sleeping";
    state.sleepStage = "awake";
    state.idleSeconds = 0;
    setRobotMood("happy");
    document.getElementById("sleep-zzz").classList.add("hidden");

    const voicePill = document.getElementById("hdr-voice-pill");
    voicePill.classList.remove("sleeping");
    voicePill.classList.add("listening");
    document.getElementById("hdr-voice-text").textContent = "Đang nghe";

    if (getRobotNative()) {
      getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
    }
    sendBleCommand("M:WAKE");
    updateSleepBadge();

    if (announce && wasSleeping) {
      const m = getActiveMember();
      const hour = new Date().getHours();
      const greeting = hour < 12 ? "Chào buổi sáng" : hour < 18 ? "Chào buổi chiều" : "Chào buổi tối";
      const msg = `${greeting} ${m.name}! Lucky đã thức dậy rồi đây. Bạn muốn làm gì nào?`;
      setRobotBubble(msg);
      speakFeedback(msg, "vi-VN");
      logActivityToServer("WAKE_UP", `Đánh thức bởi ${m.name}`);
    } else {
      ensureAlwaysListening();
    }
  }

  let lastBedtimeDate = "";
  function checkBedtimeReminder() {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    if (lastBedtimeDate === todayStr) return;
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (hhmm === state.config.bedtime) {
      lastBedtimeDate = todayStr;
      const m = getActiveMember();
      speakFeedback(`Đã đến giờ đi ngủ ${state.config.bedtime} rồi ${m.name} ơi! Chúc bạn ngủ thật ngon nhé!`, "vi-VN");
    }
  }

  // ==================== ECHO GUARD + ZERO-BEEP ALWAYS LISTENING ====================
  function ensureAlwaysListening() {
    if (state.activeTab !== "robot" || state.isSpeaking || state.isRecordingLesson) return;
    if (state.isListening) return;

    if (getRobotNative()) {
      state.isListening = true;
      getRobotNative().startListening({ lang: "vi-VN" }).catch(() => {
        state.isListening = false;
      });
    }
  }

  function stopAllSpeechAndMic() {
    state.isSpeaking = false;
    state.isListening = false;
    state.isRecordingLesson = false;
    try { state.audioPlayer.pause(); } catch (_) {}
    if (getRobotNative()) {
      getRobotNative().stopSpeak().catch(() => {});
      getRobotNative().stopListening().catch(() => {});
    } else if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  function speakFeedback(text, lang = "vi-VN") {
    setRobotBubble(text);
    // Echo Guard: Ngắt mic trước khi phát giọng nói
    state.isSpeaking = true;
    state.isListening = false;
    setRobotMood("speaking");

    if (getRobotNative()) {
      getRobotNative().stopListening().catch(() => {});
      getRobotNative().speak({
        text,
        lang,
        rate: state.config.speechRate,
        pitch: 1.08
      }).catch(() => {
        onSpeechFinished();
      });
    } else if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = state.config.speechRate;
      u.onend = onSpeechFinished;
      u.onerror = onSpeechFinished;
      window.speechSynthesis.speak(u);
    } else {
      setTimeout(onSpeechFinished, 1200);
    }
  }

  function onSpeechFinished() {
    state.isSpeaking = false;
    if (state.sleepStage === "sleeping") {
      setRobotMood("sleeping");
    } else {
      setRobotMood("happy");
    }
    // Bật lại Always-Listening sau 350ms tránh vang âm
    setTimeout(() => {
      if (state.activeTab === "robot" && !state.isSpeaking && !state.isRecordingLesson) {
        ensureAlwaysListening();
      }
    }, 350);
  }

  // ==================== SMART VOICE COMMAND PARSER ("TÔI MUỐN...") ====================
  function normalizeVi(str) {
    return (str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d")
      .trim();
  }

  function parseRepeatCount(normText) {
    const digitMatch = normText.match(/(\d+)\s*lan/);
    if (digitMatch) return Math.min(10, Math.max(1, parseInt(digitMatch[1], 10)));
    const wordMap = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
    for (const [w, num] of Object.entries(wordMap)) {
      if (normText.includes(`${w} lan`)) return num;
    }
    return 1;
  }

  function isKaraokePanelOpen() {
    const panel = document.getElementById("karaoke-panel");
    return panel && !panel.classList.contains("hidden");
  }

  function isVietnameseLessonControlCommand(norm) {
    return (
      norm.includes("dung hoc") ||
      norm.includes("dong bang hoc") ||
      norm.includes("tat bang hoc") ||
      norm.includes("nghe mau") ||
      norm.includes("doc mau") ||
      norm.includes("cau tiep") ||
      norm.includes("cau sau") ||
      norm.includes("cau truoc") ||
      norm.includes("quay lai") ||
      norm.includes("dich cau") ||
      norm.includes("nghia la gi") ||
      norm.includes("danh van") ||
      norm.startsWith("toi muon") ||
      norm.includes("mo youtube") ||
      norm.includes("choi game") ||
      norm.includes("den dau") ||
      norm.includes("den tay") ||
      norm.includes("den ngu") ||
      norm.includes("xoay dau") ||
      norm.includes("gat dau") ||
      norm.includes("lac dau")
    );
  }

  function handleVoiceTranscript(rawText) {
    const text = (rawText || "").trim();
    if (!text) return;
    document.getElementById("user-heard-line").textContent = `🗣️ Bạn nói: "${text}"`;
    const norm = normalizeVi(text);

    if (state.sleepStage === "sleeping") {
      if (norm.includes("hello") || norm.includes("he lo") || norm.includes("lucky") || norm.includes("lac ki")) {
        wakeRobot(true);
      }
      return;
    }

    // Có tương tác -> reset bộ đếm ngủ
    resetIdleTimer();

    // 1. Ưu tiên tuyệt đối: Nếu đang bấm "Bé đọc" -> chấm điểm phát âm tiếng Anh ngay
    if (state.isRecordingLesson) {
      state.isRecordingLesson = false;
      evaluateEnglishPronunciation(text);
      return;
    }

    // 2. Nếu Bảng luyện đọc tiếng Anh đang mở và bé đọc câu tiếng Anh (không phải lệnh điều khiển tiếng Việt) -> chấm điểm luôn!
    if (isKaraokePanelOpen() && !isVietnameseLessonControlCommand(norm)) {
      evaluateEnglishPronunciation(text);
      return;
    }

    // 3. Kiểm tra từ khóa đánh thức 3 chiều: "Hello", "Lucky", "Hello Lucky"
    const isWakeWord =
      norm === "hello" ||
      norm === "he lo" ||
      norm === "lucky" ||
      norm === "lac ki" ||
      norm === "hello lucky" ||
      norm === "he lo lac ki" ||
      norm.startsWith("hello lucky") ||
      norm.startsWith("lucky oi");

    if (isWakeWord) {
      const m = getActiveMember();
      speakFeedback(`Dạ, Lucky nghe đây ${m.name} ơi! Bạn muốn học bài, bật đèn, xoay đầu hay giải trí nào?`, "vi-VN");
      return;
    }

    // 3. Chuyển thành viên gia đình ("Tôi là [Tên]" / "Đổi sang [Tên]")
    if (norm.startsWith("toi la ") || norm.includes("doi sang ")) {
      const spokenName = norm.replace(/^toi la\s+/, "").replace(/^.*doi sang\s+/, "").trim();
      const found = state.members.find(m => normalizeVi(m.name).includes(spokenName) || spokenName.includes(normalizeVi(m.name)));
      if (found) {
        state.activeMemberId = found.id;
        saveLocalState();
        updateHeaderMemberUI();
        speakFeedback(`Chào ${found.name}! Mình đã chuyển sang hồ sơ của bạn với ${found.stars} ngôi sao rồi nhé!`, "vi-VN");
        return;
      }
    }

    // 4. Điều khiển Đèn đầu & Đèn tay ESP32
    if (norm.includes("den ngu")) {
      setHeadLight(false);
      setArmLight(true);
      sendBleCommand("L:NIGHT_ON");
      speakFeedback("Mình đã bật chế độ đèn ngủ dịu nhẹ ở hai tay rồi nhé!", "vi-VN");
      return;
    }
    if (norm.includes("tat het den") || norm.includes("tat tat ca den")) {
      setHeadLight(false);
      setArmLight(false);
      sendBleCommand("L:ALL_OFF");
      speakFeedback("Đã tắt toàn bộ đèn đầu và đèn tay của robot!", "vi-VN");
      return;
    }
    if (norm.includes("den dau")) {
      const turnOn = norm.includes("mo") || norm.includes("bat");
      setHeadLight(turnOn);
      sendBleCommand(turnOn ? "L:HEAD_ON" : "L:HEAD_OFF");
      speakFeedback(turnOn ? "Đã mở đèn trên đầu robot!" : "Đã tắt đèn trên đầu robot!", "vi-VN");
      return;
    }
    if (norm.includes("den tay")) {
      const turnOn = norm.includes("mo") || norm.includes("bat");
      setArmLight(turnOn);
      sendBleCommand(turnOn ? "L:ARM_ON" : "L:ARM_OFF");
      speakFeedback(turnOn ? "Đã mở đèn ở hai tay robot!" : "Đã tắt đèn ở hai tay robot!", "vi-VN");
      return;
    }

    // 5. Điều khiển Xoay đầu đa hướng & nhiều lần (ESP32 Servo)
    if (norm.includes("xoay dau") || norm.includes("quay dau") || norm.includes("gat dau") || norm.includes("lac dau") || norm.includes("ngang dau") || norm.includes("cui dau")) {
      const times = parseRepeatCount(norm);
      if (norm.includes("gat dau")) {
        sendBleCommand(`M:NOD:${times}`);
        speakFeedback(`Mình gật đầu ${times} lần đây!`, "vi-VN");
        return;
      }
      if (norm.includes("lac dau") || (norm.includes("trai") && norm.includes("phai"))) {
        executeHeadSweep(times);
        speakFeedback(`Đang xoay đầu trái phải ${times} lần theo ý bạn!`, "vi-VN");
        return;
      }
      if (norm.includes("trai")) {
        sendBleCommand(`M:HEAD_L:${times}`);
        animatePupils(-14, 0);
        speakFeedback("Mình đã xoay đầu sang bên trái!", "vi-VN");
        return;
      }
      if (norm.includes("phai")) {
        sendBleCommand(`M:HEAD_R:${times}`);
        animatePupils(14, 0);
        speakFeedback("Mình đã xoay đầu sang bên phải!", "vi-VN");
        return;
      }
      if (norm.includes("len") || norm.includes("ngang")) {
        sendBleCommand(`M:HEAD_U:${times}`);
        animatePupils(0, -12);
        speakFeedback("Mình đã ngẩng đầu lên!", "vi-VN");
        return;
      }
      if (norm.includes("xuong") || norm.includes("cui")) {
        sendBleCommand(`M:HEAD_D:${times}`);
        animatePupils(0, 12);
        speakFeedback("Mình đã cúi đầu xuống!", "vi-VN");
        return;
      }
    }

    // 6. Điều khiển Màn hình & Âm lượng
    if (norm.includes("tang sang")) {
      state.config.brightness = Math.min(100, state.config.brightness + 20);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
      syncSettingsUI();
      speakFeedback(`Đã tăng độ sáng màn hình lên ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("giam sang")) {
      state.config.brightness = Math.max(15, state.config.brightness - 20);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
      syncSettingsUI();
      speakFeedback(`Đã giảm độ sáng màn hình xuống ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("tang am luong") || norm.includes("noi to len")) {
      state.config.volume = Math.min(100, state.config.volume + 15);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setVolume({ level: state.config.volume }).catch(() => {});
      syncSettingsUI();
      speakFeedback(`Đã tăng âm lượng lên ${state.config.volume} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("giam am luong") || norm.includes("noi nho lai")) {
      state.config.volume = Math.max(10, state.config.volume - 15);
      saveLocalState();
      if (getRobotNative()) getRobotNative().setVolume({ level: state.config.volume }).catch(() => {});
      syncSettingsUI();
      speakFeedback(`Đã giảm âm lượng xuống ${state.config.volume} phần trăm!`, "vi-VN");
      return;
    }

    // 7. Điều hướng Giải trí & Học tập ("Tôi muốn...")
    if (norm.includes("youtube") || norm.includes("xem video") || norm.includes("xem phim")) {
      speakFeedback("Mở YouTube ngay đây!", "vi-VN");
      switchTab("youtube");
      return;
    }
    if (norm.includes("choi game") || norm.includes("tro choi")) {
      speakFeedback("Vào khu vực trò chơi tích điểm thôi nào!", "vi-VN");
      switchTab("game");
      return;
    }
    if (norm.includes("huong dan")) {
      switchTab("guide");
      speakFeedback("Đây là bảng hướng dẫn sử dụng chi tiết của robot!", "vi-VN");
      return;
    }
    if (norm.includes("dung hoc") || norm.includes("dong bang hoc")) {
      toggleKaraokePanel(false);
      speakFeedback("Mình đã tạm đóng bảng học. Khi nào muốn học tiếp cứ gọi mình nhé!", "vi-VN");
      return;
    }
    if (norm.includes("on tu kho")) {
      loadHardWordsPractice();
      return;
    }
    if (norm.includes("hoc ngau nhien")) {
      loadRandomPractice();
      return;
    }
    if (norm.includes("dich cau") || norm.includes("nghia la gi")) {
      const cur = state.sentences[state.sentenceIndex];
      if (cur) {
        speakFeedback(`Câu này có nghĩa là: ${cur.vi || "Chưa có bản dịch tiếng Việt"}`, "vi-VN");
      }
      return;
    }
    if (norm.includes("danh van")) {
      const wordMatch = norm.replace(/^.*danh van\s*(tu\s*)?/, "").trim().split(/\s+/)[0];
      if (wordMatch) {
        spellWordViaApi(wordMatch);
        return;
      }
    }
    if (norm.includes("nghe mau") || norm.includes("doc mau")) {
      playCurrentSentenceSample();
      return;
    }
    if (norm.includes("cau tiep") || norm.includes("tiep theo")) {
      nextSentence();
      return;
    }
    if (norm.includes("cau truoc") || norm.includes("quay lai")) {
      prevSentence();
      return;
    }
    if (norm.includes("hoc chu de") || norm.includes("toi muon hoc")) {
      const numMatch = norm.match(/chu de\s*(\d+)/);
      if (numMatch && state.topics.length > 0) {
        const idx = parseInt(numMatch[1], 10) - 1;
        if (state.topics[idx]) {
          selectAndDownloadTopic(state.topics[idx].topic, state.topics[idx].title);
          return;
        }
      }
      toggleKaraokePanel(true);
      playCurrentSentenceSample();
      return;
    }

    // 8. Đổi vai trò giao tiếp
    const roles = [
      { key: "bac si", label: "🩺 Bác sĩ tận tâm", reply: "Xin chào, mình là Bác sĩ Lucky. Hôm nay bạn cảm thấy trong người thế nào, có mệt hay đau ở đâu không?" },
      { key: "dieu duong", label: "👩‍⚕️ Điều dưỡng chăm sóc", reply: "Mình đã chuyển sang chế độ Điều dưỡng. Nhớ uống đủ nước và ngồi thẳng lưng nhé!" },
      { key: "ban than", label: "🤝 Bạn thân vui tính", reply: "Ok luôn! Mình là bạn thân của bạn đây, hôm nay có chuyện gì vui kể mình nghe đi!" },
      { key: "ke chuyen", label: "📚 Người kể chuyện", reply: "Ngày xửa ngày xưa, có một chú thỏ trắng thông minh rất thích học tiếng Anh..." },
      { key: "co giao", label: "🎓 Cô giáo tiếng Anh", reply: "Cô giáo Lucky sẵn sàng rồi! Chúng ta cùng luyện phát âm thật chuẩn nhé!" }
    ];
    for (const r of roles) {
      if (norm.includes(r.key)) {
        state.roleName = r.label;
        document.getElementById("role-badge").textContent = r.label;
        speakFeedback(r.reply, "vi-VN");
        return;
      }
    }

    // 9. Trạng thái thiết bị, giờ, sức khỏe & đi ngủ
    if (norm.includes("may gio") || norm.includes("thoi gian")) {
      const now = new Date();
      speakFeedback(`Bây giờ là ${now.getHours()} giờ ${now.getMinutes()} phút rồi bạn nhé!`, "vi-VN");
      return;
    }
    if (norm.includes("pin") || norm.includes("nhiet do")) {
      const bat = document.getElementById("hdr-battery").textContent;
      const tmp = document.getElementById("hdr-temp").textContent;
      speakFeedback(`Máy hiện còn ${bat} và nhiệt độ là ${tmp}.`, "vi-VN");
      return;
    }
    if (norm.includes("met") || norm.includes("om") || norm.includes("dau dau") || norm.includes("buon")) {
      speakFeedback("Thương bạn quá! Nếu thấy mệt bạn hãy nhắm mắt nghỉ ngơi một chút, uống nước ấm và nói với bố mẹ nhé!", "vi-VN");
      return;
    }
    if (norm.includes("di ngu") || norm.includes("ngu di")) {
      enterBatterySleepMode();
      return;
    }

    // Phản hồi hội thoại chủ động mặc định
    const m = getActiveMember();
    speakFeedback(`${m.name} ơi, mình nghe bạn nói "${text}". Bạn muốn mở bài học tiếng Anh, bật đèn, xoay đầu hay giải trí không?`, "vi-VN");
  }

  // ==================== KARAOKE LEARNING & PRONUNCIATION SCORING ====================
  function toggleKaraokePanel(show) {
    const stage = document.getElementById("robot-stage");
    const panel = document.getElementById("karaoke-panel");
    if (show) {
      stage.classList.remove("full-face");
      stage.classList.add("split-mode");
      panel.classList.remove("hidden");
      renderCurrentSentence();
    } else {
      stage.classList.add("full-face");
      stage.classList.remove("split-mode");
      panel.classList.add("hidden");
    }
  }

  function renderCurrentSentence() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    document.getElementById("k-topic-title").textContent = `Chủ đề: ${state.currentTopicTitle}`;
    document.getElementById("k-progress-text").textContent = `Câu ${state.sentenceIndex + 1} / ${state.sentences.length}`;

    const enBox = document.getElementById("k-sentence-en");
    enBox.innerHTML = "";
    const words = item.en.split(/\s+/);
    words.forEach((w, idx) => {
      const span = document.createElement("span");
      span.className = "k-word";
      span.dataset.idx = String(idx);
      span.textContent = w;
      enBox.appendChild(span);
    });

    const spellBox = document.getElementById("k-spelling-box");
    spellBox.innerHTML = "";
    const spellingList = Array.isArray(item.spelling) && item.spelling.length > 0
      ? item.spelling
      : words.map(w => {
          const clean = w.replace(/[^a-zA-Z0-9']/g, "");
          return { word: clean, spell: clean.toUpperCase().split("").join("-") };
        });

    spellingList.forEach(sp => {
      if (!sp.word) return;
      const chip = document.createElement("span");
      chip.className = "spell-chip";
      chip.textContent = `${sp.word}: ${sp.spell}`;
      spellBox.appendChild(chip);
    });

    document.getElementById("k-sentence-vi").textContent = item.vi || "Đang cập nhật nghĩa tiếng Việt...";
    document.getElementById("k-score-label").textContent = "Điểm phát âm: Sẵn sàng";
    document.getElementById("k-heard-words").textContent = "";
  }

  function playCurrentSentenceSample() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;
    resetIdleTimer();

    // Tô sáng lần lượt từng từ theo nhịp đọc
    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    wordEls.forEach(el => el.classList.remove("active", "matched", "missed"));
    wordEls.forEach((el, idx) => {
      setTimeout(() => {
        wordEls.forEach(w => w.classList.remove("active"));
        el.classList.add("active");
      }, idx * 320);
    });

    if (item.audio_url) {
      state.isSpeaking = true;
      state.isListening = false;
      if (getRobotNative()) getRobotNative().stopListening().catch(() => {});
      setRobotMood("speaking");
      state.audioPlayer.src = item.audio_url;
      state.audioPlayer.onended = () => {
        wordEls.forEach(w => w.classList.remove("active"));
        onSpeechFinished();
      };
      state.audioPlayer.onerror = () => {
        speakFeedback(item.en, "en-US");
      };
      state.audioPlayer.play().catch(() => speakFeedback(item.en, "en-US"));
    } else {
      speakFeedback(item.en, "en-US");
    }
  }

  function startLessonRecording() {
    resetIdleTimer();
    state.isRecordingLesson = true;
    setRobotMood("listening");
    document.getElementById("k-score-label").textContent = "🎙️ Đang nghe bé đọc tiếng Anh...";
    document.getElementById("k-heard-words").textContent = "Hãy đọc to câu tiếng Anh ở trên nhé!";

    if (getRobotNative()) {
      state.isListening = true;
      getRobotNative().startListening({ lang: "en-US" }).catch(() => {
        state.isListening = false;
      });
    }
  }

  function evaluateEnglishPronunciation(spokenText) {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    const cleanTarget = item.en.toLowerCase().replace(/[^a-z0-9'\s]/g, "").split(/\s+/).filter(Boolean);
    const cleanSpoken = spokenText.toLowerCase().replace(/[^a-z0-9'\s]/g, "").split(/\s+/).filter(Boolean);

    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    const wrongWords = [];
    let matched = 0;

    cleanTarget.forEach((tw, idx) => {
      const ok = cleanSpoken.includes(tw);
      if (ok) {
        matched++;
        if (wordEls[idx]) wordEls[idx].classList.add("matched");
      } else {
        wrongWords.push(tw);
        if (wordEls[idx]) wordEls[idx].classList.add("missed");
      }
    });

    const score = cleanTarget.length > 0 ? Math.round((matched / cleanTarget.length) * 100) : 0;
    document.getElementById("k-score-label").textContent = `Điểm: ${score}% (${matched}/${cleanTarget.length} từ)`;
    document.getElementById("k-heard-words").textContent = `Nghe được: "${spokenText}"`;

    // Ghi nhận tiến độ lên api_user.php
    const m = getActiveMember();
    fetch(apiUrl("api_user.php", { action: "log_learning", bot_id: m.uid }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "log_learning",
        bot_id: m.uid,
        topic: state.currentTopic,
        sentence_id: item.id,
        en: item.en,
        score,
        status: score >= 80 ? "passed" : "review",
        wrong_words: wrongWords
      })
    }).catch(() => {});

    if (score >= 75) {
      addStarsToActiveMember(1, `Đọc chuẩn câu: ${item.en}`);
      if (state.sentences.length > 1) {
        speakFeedback(`Tuyệt vời! Bạn đạt ${score} điểm, được cộng 1 sao và chuyển sang câu tiếp theo nhé!`, "vi-VN");
        setTimeout(() => {
          if (isKaraokePanelOpen()) nextSentence();
        }, 2600);
      } else {
        speakFeedback(`Tuyệt vời! Bạn đạt ${score} điểm và được thưởng thêm 1 ngôi sao!`, "vi-VN");
      }
    } else {
      speakFeedback(`Bạn đạt ${score} điểm. Cùng nghe mẫu lại một lần rồi bấm Bé đọc nhé!`, "vi-VN");
    }
  }

  function nextSentence() {
    if (state.sentences.length === 0) return;
    state.sentenceIndex = (state.sentenceIndex + 1) % state.sentences.length;
    renderCurrentSentence();
    playCurrentSentenceSample();
  }

  function prevSentence() {
    if (state.sentences.length === 0) return;
    state.sentenceIndex = (state.sentenceIndex - 1 + state.sentences.length) % state.sentences.length;
    renderCurrentSentence();
    playCurrentSentenceSample();
  }

  // ==================== DYNAMIC TOPICS (> 32) & BATCH DOWNLOAD ====================
  async function loadTopicsList(forceRefresh = true) {
    const grid = document.getElementById("topics-grid");
    const summary = document.getElementById("topics-summary-text");

    if (!forceRefresh && state.topics.length > 0) {
      renderTopicsGrid();
    }

    try {
      summary.textContent = "Đang đồng bộ danh sách chủ đề từ máy chủ...";
      const res = await fetch(apiUrl("api.php", { action: "topics", t: Date.now() }));
      const data = await res.json();
      if (data.status === "ok" && Array.isArray(data.topics)) {
        state.topics = data.topics;
        localStorage.setItem("rb_v14_topics", JSON.stringify(state.topics));
        summary.textContent = `Đã đồng bộ ${data.total_topics} chủ đề (${data.total_sentences.toLocaleString()} câu tiếng Anh). Tự cập nhật khi có chủ đề mới!`;
        renderTopicsGrid();
      }
    } catch (_) {
      summary.textContent = `Đang dùng ${state.topics.length} chủ đề đã lưu offline trên máy.`;
      renderTopicsGrid();
    }
  }

  function renderTopicsGrid() {
    const grid = document.getElementById("topics-grid");
    grid.innerHTML = "";
    state.topics.forEach(t => {
      const cached = localStorage.getItem(`rb_topic_data_${t.topic}`);
      const card = document.createElement("div");
      card.className = "topic-card";
      card.innerHTML = `
        <div>
          <h4>#${t.index} • ${t.title}</h4>
          <p class="topic-meta">${t.count} câu • ${t.has_vi ? "Có dịch Việt" : "Tiếng Anh"} • ${t.has_audio ? "MP3 bản xứ" : "TTS"}</p>
        </div>
        <div class="topic-meta">${cached ? "✅ Đã lưu Offline" : "☁️ Chạm để tải & học"}</div>
      `;
      card.onclick = () => selectAndDownloadTopic(t.topic, t.title, t.version_hash);
      grid.appendChild(card);
    });
  }

  async function selectAndDownloadTopic(topicSlug, title, serverHash = "") {
    state.currentTopic = topicSlug;
    state.currentTopicTitle = title || topicSlug;

    const cacheKey = `rb_topic_data_${topicSlug}`;
    const hashKey = `rb_topic_hash_${topicSlug}`;
    const localHash = localStorage.getItem(hashKey);

    if (localHash && (!serverHash || localHash === serverHash)) {
      const cachedItems = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (Array.isArray(cachedItems) && cachedItems.length > 0) {
        state.sentences = cachedItems;
        state.sentenceIndex = 0;
        switchTab("robot");
        toggleKaraokePanel(true);
        playCurrentSentenceSample();
        return;
      }
    }

    // Tải phân lô tự động (batch 250 câu/lượt) để xử lý mượt kho câu lớn
    try {
      let allItems = [];
      let offset = 0;
      const limit = 250;
      let latestHash = serverHash;

      while (true) {
        const res = await fetch(apiUrl("api.php", { action: "download", topic: topicSlug, offset, limit }));
        const data = await res.json();
        if (data.status !== "ok" || !Array.isArray(data.items)) break;
        latestHash = data.version_hash || latestHash;
        allItems = allItems.concat(data.items);
        if (allItems.length >= data.total || data.items.length < limit) break;
        offset += limit;
      }

      if (allItems.length > 0) {
        state.sentences = allItems;
        state.sentenceIndex = 0;
        try {
          localStorage.setItem(cacheKey, JSON.stringify(allItems.slice(0, 1000)));
          if (latestHash) localStorage.setItem(hashKey, latestHash);
        } catch (_) {}
        switchTab("robot");
        toggleKaraokePanel(true);
        playCurrentSentenceSample();
      }
    } catch (_) {
      speakFeedback("Không tải được chủ đề do mất mạng, bạn chọn chủ đề đã lưu offline nhé!", "vi-VN");
    }
  }

  async function loadRandomPractice() {
    try {
      const res = await fetch(apiUrl("api.php", { action: "random", topic: state.currentTopic, count: 10 }));
      const data = await res.json();
      if (data.status === "ok" && data.items?.length > 0) {
        state.currentTopicTitle = `Ôn ngẫu nhiên (${data.title})`;
        state.sentences = data.items;
        state.sentenceIndex = 0;
        switchTab("robot");
        toggleKaraokePanel(true);
        playCurrentSentenceSample();
      }
    } catch (_) {}
  }

  async function loadHardWordsPractice() {
    const m = getActiveMember();
    try {
      const res = await fetch(apiUrl("api_user.php", { action: "get_progress", bot_id: m.uid }));
      const data = await res.json();
      const hardObj = data.progress?.hard_words || {};
      const words = Object.keys(hardObj);
      if (words.length === 0) {
        speakFeedback(`${m.name} giỏi quá, hiện chưa có từ nào phát âm sai cần ôn lại!`, "vi-VN");
        return;
      }
      state.currentTopicTitle = `Từ khó của ${m.name}`;
      state.sentences = words.slice(0, 15).map((w, i) => ({
        id: i,
        en: w,
        vi: `Từ cần luyện phát âm (${hardObj[w]} lần chưa chuẩn)`,
        audio_url: "",
        spelling: [{ word: w, spell: w.toUpperCase().split("").join("-") }]
      }));
      state.sentenceIndex = 0;
      switchTab("robot");
      toggleKaraokePanel(true);
      playCurrentSentenceSample();
    } catch (_) {
      speakFeedback("Chưa tải được danh sách từ khó từ máy chủ.", "vi-VN");
    }
  }

  async function spellWordViaApi(word) {
    try {
      const res = await fetch(apiUrl("api.php", { action: "word", w: word }));
      const data = await res.json();
      const spell = data.spell || word.toUpperCase().split("").join("-");
      speakFeedback(`Từ ${word} đánh vần là: ${spell}`, "en-US");
    } catch (_) {
      const spell = word.toUpperCase().split("").join("-");
      speakFeedback(`Từ ${word} đánh vần là: ${spell}`, "en-US");
    }
  }

  // ==================== ESP32 BLE & PHYSICAL LIGHTS / HEAD SERVO ====================
  async function scanAndConnectBle() {
    const detail = document.getElementById("ble-status-detail");
    if (!getBleClient()) {
      detail.textContent = "Trạng thái: Chỉ hỗ trợ trên App Android APK (BLE Native)";
      return;
    }
    try {
      detail.textContent = "Đang quét mạch ESP32 Robot...";
      await getBleClient().initialize();
      const device = await getBleClient().requestDevice({
        optionalServices: [BLE_SERVICE_UUID]
      });
      await getBleClient().connect(device.deviceId, () => {
        state.bleConnected = false;
        updateBleHeaderUI();
      });
      state.bleDeviceId = device.deviceId;
      state.bleConnected = true;
      updateBleHeaderUI();
      detail.textContent = `Đã kết nối: ${device.name || device.deviceId}`;

      // Lắng nghe nút bấm vật lý & cảm biến chạm từ ESP32
      await getBleClient().startNotifications(device.deviceId, BLE_SERVICE_UUID, BLE_CHAR_RX_UUID, val => {
        const msg = new TextDecoder().decode(val.buffer).trim();
        handleEspHardwareEvent(msg);
      });
    } catch (err) {
      detail.textContent = `Lỗi kết nối BLE: ${err?.message || "Đã hủy"}`;
    }
  }

  function updateBleHeaderUI() {
    const pill = document.getElementById("hdr-ble-pill");
    const txt = document.getElementById("hdr-ble-text");
    if (state.bleConnected) {
      pill.classList.remove("offline");
      pill.classList.add("online");
      txt.textContent = "ESP32: Kết nối";
    } else {
      pill.classList.remove("online");
      pill.classList.add("offline");
      txt.textContent = "ESP32: Chờ";
    }
  }

  async function sendBleCommand(cmd) {
    if (!getBleClient() || !state.bleConnected || !state.bleDeviceId) return;
    try {
      const encoder = new TextEncoder();
      const dataView = new DataView(encoder.encode(cmd + "\n").buffer);
      await getBleClient().write(state.bleDeviceId, BLE_SERVICE_UUID, BLE_CHAR_TX_UUID, dataView);
    } catch (_) {}
  }

  function handleEspHardwareEvent(msg) {
    resetIdleTimer();
    if (msg === "TOUCH_HEAD" || msg === "PIR_WAKE") {
      wakeRobot(true);
    } else if (msg === "BTN_1") {
      playCurrentSentenceSample();
    } else if (msg === "BTN_2") {
      startLessonRecording();
    } else if (msg === "BTN_3") {
      nextSentence();
    } else if (msg === "BTN_4") {
      const cur = state.sentences[state.sentenceIndex];
      if (cur?.vi) speakFeedback(cur.vi, "vi-VN");
    }
  }

  function setHeadLight(on) {
    state.headLightOn = on;
    const el = document.getElementById("head-led-indicator");
    el.textContent = on ? "💡 Đèn đầu: Bật" : "💡 Đèn đầu: Tắt";
    el.classList.toggle("on", on);
  }

  function setArmLight(on) {
    state.armLightOn = on;
    const el = document.getElementById("arm-led-indicator");
    el.textContent = on ? "🦾 Đèn tay: Bật" : "🦾 Đèn tay: Tắt";
    el.classList.toggle("on", on);
  }

  function executeHeadSweep(times) {
    sendBleCommand(`M:HEAD_SWEEP:${times}`);
    let step = 0;
    const totalSteps = times * 2;
    const iv = setInterval(() => {
      animatePupils(step % 2 === 0 ? -15 : 15, 0);
      step++;
      if (step >= totalSteps) {
        clearInterval(iv);
        setTimeout(() => animatePupils(0, 0), 300);
      }
    }, 350);
  }

  // ==================== ROBOT FACE ANIMATION ====================
  function setRobotMood(mood) {
    const head = document.getElementById("robot-head");
    head.className = `robot-head mood-${mood}`;
  }

  function setRobotBubble(text) {
    document.getElementById("robot-bubble").textContent = text;
  }

  function animatePupils(dx, dy) {
    document.querySelectorAll(".pupil").forEach(p => {
      p.style.transform = `translate(${dx}px, ${dy}px)`;
    });
  }

  function startNaturalBlinkLoop() {
    setInterval(() => {
      if (state.sleepStage === "sleeping") return;
      document.querySelectorAll(".eye").forEach(e => e.classList.add("blink"));
      setTimeout(() => {
        document.querySelectorAll(".eye").forEach(e => e.classList.remove("blink"));
      }, 170);
    }, 3800);
  }

  // ==================== 2-TIER SECURITY: PARENTAL PIN & DEVELOPER EXIT ====================
  function openPinModal() {
    const inp = document.getElementById("pin-modal-input");
    inp.value = "";
    inp.type = "password";
    document.getElementById("pin-modal-error").classList.add("hidden");
    document.getElementById("pin-modal").classList.remove("hidden");
  }

  function closePinModal() {
    document.getElementById("pin-modal").classList.add("hidden");
    state.pendingTab = null;
  }

  function verifyParentPin() {
    const entered = document.getElementById("pin-modal-input").value.trim();
    const isMatch =
      entered === state.config.parentPin ||
      entered === MASTER_NUMERIC_PIN ||
      entered.toLowerCase() === MASTER_TEST_PASS;

    if (isMatch) {
      state.settingsUnlocked = true;
      const target = state.pendingTab || "settings";
      closePinModal();
      syncSettingsUI();
      switchTab(target);
    } else {
      document.getElementById("pin-modal-error").classList.remove("hidden");
    }
  }

  async function lockDeveloperKiosk() {
    const stateLabel = document.getElementById("dev-lock-state");
    if (!getRobotNative()) {
      stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#f59e0b;">CHỈ HOẠT ĐỘNG TRÊN APP ANDROID</strong>';
      return;
    }
    try {
      const res = await getRobotNative().setKioskMode({ enabled: true });
      if (res && res.isPinned) {
        stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#ef4444;">ĐANG GHIM ỨNG DỤNG (ĐÃ KHÓA THOÁT)</strong>';
        speakFeedback("Đã bật chế độ ghim ứng dụng thành công!", "vi-VN");
      } else {
        stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#f59e0b;">ĐÃ BẬT FULLSCREEN (HÃY CHẤP NHẬN GHIM MÀN HÌNH NẾU ANDROID HỎI)</strong>';
      }
    } catch (e) {
      stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#ef4444;">LỖI KHI BẬT GHIM</strong>';
    }
  }

  async function checkKioskPinStatus() {
    const stateLabel = document.getElementById("dev-lock-state");
    if (!getRobotNative()) return;
    try {
      const st = await getRobotNative().getDeviceStatus();
      if (st.isPinned) {
        stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#ef4444;">ĐANG GHIM ỨNG DỤNG (ĐÃ KHÓA THOÁT)</strong>';
      } else if (st.kioskLocked) {
        stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#f59e0b;">ĐANG BẬT CHẾ ĐỘ KIOSK (CHƯA KHÓA HỆ THỐNG)</strong>';
      } else {
        stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#22c55e;">ĐANG MỞ (KHÔNG GHIM)</strong>';
      }
    } catch (_) {}
  }

  async function unlockDeveloperKioskExit() {
    const code = document.getElementById("dev-exit-code-input").value.trim();
    const stateLabel = document.getElementById("dev-lock-state");
    if (code.toUpperCase() === DEVELOPER_MASTER_CODE || code === MASTER_NUMERIC_PIN) {
      if (getRobotNative()) {
        await getRobotNative().setKioskMode({ enabled: false }).catch(() => {});
      }
      stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#22c55e;">ĐÃ MỞ KHÓA THOÁT APP</strong>';
      speakFeedback("Đã xác thực thành công. Chế độ ghim ứng dụng đã được gỡ bỏ!", "vi-VN");
    } else {
      stateLabel.innerHTML = 'Trạng thái Kiosk: <strong style="color:#ef4444;">SAI MÃ NHÀ PHÁT TRIỂN!</strong>';
      speakFeedback("Sai mã Nhà phát triển! Không thể gỡ ghim.", "vi-VN");
    }
  }

  // ==================== SETTINGS & MEMBERS UI ====================
  function syncSettingsUI() {
    document.getElementById("set-study-only").checked = state.config.studyOnly;
    const baseInput = document.getElementById("set-base-url");
    if (baseInput) baseInput.value = state.config.baseUrl;
    document.getElementById("set-bedtime").value = state.config.bedtime;
    document.getElementById("set-brightness").value = state.config.brightness;
    document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
    document.getElementById("set-volume").value = state.config.volume;
    document.getElementById("val-volume").textContent = `${state.config.volume}%`;
    document.getElementById("set-rate").value = state.config.speechRate;
    document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
    document.getElementById("set-base-url").value = state.config.baseUrl;
    renderMembersSettingsList();
    checkKioskPinStatus();
  }

  function renderMembersSettingsList() {
    const list = document.getElementById("members-list");
    list.innerHTML = "";
    state.members.forEach(m => {
      const isCurrent = m.id === state.activeMemberId;
      const row = document.createElement("div");
      row.className = "member-item";
      row.innerHTML = `
        <span>${m.avatar} <strong>${m.name}</strong> (${m.age} tuổi) • ★ ${m.stars} ${isCurrent ? "✅" : ""}</span>
        <div class="btn-group-wrap">
          <button class="action-btn primary" data-act="use">Chọn</button>
          ${state.members.length > 1 ? '<button class="action-btn danger" data-act="del">Xóa</button>' : ""}
        </div>
      `;
      row.querySelector('[data-act="use"]').onclick = () => {
        state.activeMemberId = m.id;
        saveLocalState();
        updateHeaderMemberUI();
        renderMembersSettingsList();
      };
      const delBtn = row.querySelector('[data-act="del"]');
      if (delBtn) {
        delBtn.onclick = () => {
          state.members = state.members.filter(x => x.id !== m.id);
          if (state.activeMemberId === m.id) state.activeMemberId = state.members[0].id;
          saveLocalState();
          updateHeaderMemberUI();
          renderMembersSettingsList();
        };
      }
      list.appendChild(row);
    });
  }

  function openQuickMemberModal() {
    const grid = document.getElementById("quick-member-grid");
    grid.innerHTML = "";
    state.members.forEach(m => {
      const btn = document.createElement("button");
      btn.className = `action-btn ${m.id === state.activeMemberId ? "primary" : ""}`;
      btn.textContent = `${m.avatar} ${m.name} (★ ${m.stars})`;
      btn.onclick = () => {
        state.activeMemberId = m.id;
        saveLocalState();
        updateHeaderMemberUI();
        document.getElementById("member-modal").classList.add("hidden");
        speakFeedback(`Đã chuyển sang hồ sơ của ${m.name}!`, "vi-VN");
      };
      grid.appendChild(btn);
    });
    document.getElementById("member-modal").classList.remove("hidden");
  }

  // ==================== DEVICE TELEMETRY POLLING ====================
  async function refreshDeviceTelemetry() {
    const native = getRobotNative();
    if (native) {
      try {
        const st = await native.getDeviceStatus();
        const chargeIcon = st.isCharging ? "⚡" : "🔋";
        document.getElementById("hdr-battery").textContent = `${chargeIcon} ${st.battery}%`;
        document.getElementById("hdr-temp").textContent = `${Number(st.temperature).toFixed(1)}°C`;
        const wifiInfo = document.getElementById("set-wifi-info");
        if (wifiInfo) wifiInfo.textContent = `${st.wifiSsid} (${st.localIp})`;
        return;
      } catch (_) {}
    }
    if (navigator.getBattery) {
      try {
        const bat = await navigator.getBattery();
        const pct = Math.round(bat.level * 100);
        document.getElementById("hdr-battery").textContent = `${bat.charging ? "⚡" : "🔋"} ${pct}%`;
      } catch (_) {}
    }
  }

  // ==================== POSTMESSAGE BRIDGE FROM IFRAMES ====================
  window.addEventListener("message", event => {
    const data = event.data || {};
    const m = getActiveMember();
    if (data.type === "GAME_REQ_PROFILE") {
      event.source?.postMessage({ type: "APP_PROFILE_DATA", uid: m.uid, stars: m.stars }, "*");
    } else if (data.type === "APP_CHANGE_STARS") {
      const delta = parseInt(data.delta || 0, 10);
      if (delta < 0 && m.stars + delta < 0) {
        event.source?.postMessage({ type: "APP_STARS_RESULT", ok: false, stars: m.stars }, "*");
        return;
      }
      addStarsToActiveMember(delta, "Trò chơi tương tác");
      event.source?.postMessage({ type: "APP_STARS_RESULT", ok: true, stars: m.stars }, "*");
    } else if (data.type === "GAME_ESP_CMD") {
      sendBleCommand(data.cmd);
    }
  });

  // ==================== EVENT BINDINGS & INIT ====================
  function bindEvents() {
    // Nav dock
    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        resetIdleTimer();
        switchTab(btn.dataset.tab);
      });
    });

    // Nút Refresh 🔄 chỉ hiện ở YouTube / Game
    document.getElementById("btn-refresh-frame").addEventListener("click", () => {
      const m = getActiveMember();
      if (state.activeTab === "youtube") {
        document.getElementById("frame-youtube").src = apiUrl("youtube.php", { uid: m.uid, stars: m.stars, r: Date.now() });
      } else if (state.activeTab === "game") {
        document.getElementById("frame-game").src = apiUrl("games.php", { uid: m.uid, stars: m.stars, r: Date.now() });
      }
    });

    // Chạm màn hình Robot -> Đánh thức & reset đếm ngủ
    document.getElementById("robot-face-wrap").addEventListener("click", () => resetIdleTimer());

    // Karaoke & Quick Actions
    document.getElementById("btn-toggle-karaoke").addEventListener("click", e => {
      e.stopPropagation();
      toggleKaraokePanel(true);
    });
    document.getElementById("btn-close-karaoke").addEventListener("click", () => toggleKaraokePanel(false));
    document.getElementById("btn-quick-talk").addEventListener("click", e => {
      e.stopPropagation();
      resetIdleTimer();
      ensureAlwaysListening();
      setRobotMood("listening");
    });

    document.getElementById("btn-k-prev").addEventListener("click", prevSentence);
    document.getElementById("btn-k-next").addEventListener("click", nextSentence);
    document.getElementById("btn-k-listen").addEventListener("click", playCurrentSentenceSample);
    document.getElementById("btn-k-record").addEventListener("click", startLessonRecording);
    document.getElementById("btn-k-replay").addEventListener("click", () => {
      if (state.lastRecordedBlobUrl) {
        const a = new Audio(state.lastRecordedBlobUrl);
        a.play().catch(() => {});
      } else {
        speakFeedback("Bạn hãy bấm nút Bé đọc trước rồi nghe lại nhé!", "vi-VN");
      }
    });

    // Topics Tab
    document.getElementById("btn-sync-topics").addEventListener("click", () => loadTopicsList(true));
    document.getElementById("btn-review-hard-words").addEventListener("click", loadHardWordsPractice);

    // Member Modal
    document.getElementById("member-badge").addEventListener("click", openQuickMemberModal);
    document.getElementById("btn-member-close").addEventListener("click", () => {
      document.getElementById("member-modal").classList.add("hidden");
    });

    // PIN Modal (Bàn phím số 0-9 tích hợp + hỗ trợ nhập chữ robotrobot)
    const pinInput = document.getElementById("pin-modal-input");
    pinInput.addEventListener("keydown", e => {
      if (e.key === "Enter") verifyParentPin();
    });
    document.getElementById("btn-pin-toggle-eye").addEventListener("click", () => {
      pinInput.type = pinInput.type === "password" ? "text" : "password";
    });
    document.querySelectorAll("#pin-numpad .numpad-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        document.getElementById("pin-modal-error").classList.add("hidden");
        if (key === "CLR") {
          pinInput.value = "";
        } else if (key === "DEL") {
          pinInput.value = pinInput.value.slice(0, -1);
        } else if (pinInput.value.length < 20) {
          pinInput.value += key;
        }
      });
    });
    document.getElementById("btn-pin-cancel").addEventListener("click", closePinModal);
    document.getElementById("btn-pin-confirm").addEventListener("click", verifyParentPin);

    // Settings Controls
    document.getElementById("btn-lock-settings").addEventListener("click", () => {
      state.settingsUnlocked = false;
      switchTab("robot");
    });

    document.getElementById("btn-add-member").addEventListener("click", () => {
      const name = document.getElementById("new-member-name").value.trim();
      const age = parseInt(document.getElementById("new-member-age").value || "7", 10);
      const avatar = document.getElementById("new-member-avatar").value;
      if (!name) return;
      const newM = { id: "m_" + Date.now(), uid: generateUid20(), name, age, avatar, stars: 5 };
      state.members.push(newM);
      state.activeMemberId = newM.id;
      document.getElementById("new-member-name").value = "";
      saveLocalState();
      updateHeaderMemberUI();
      renderMembersSettingsList();
      syncMemberProfileServer(newM);
    });

    document.getElementById("set-study-only").addEventListener("change", e => {
      state.config.studyOnly = e.target.checked;
      saveLocalState();
      syncMemberProfileServer(getActiveMember());
    });

    document.getElementById("set-bedtime").addEventListener("change", e => {
      state.config.bedtime = e.target.value;
      saveLocalState();
    });

    document.getElementById("btn-save-parent-pin").addEventListener("click", () => {
      const np = document.getElementById("set-new-parent-pin").value.trim();
      if (np.length >= 4 && np.length <= 16) {
        state.config.parentPin = np;
        saveLocalState();
        document.getElementById("set-new-parent-pin").value = "";
        speakFeedback("Đã đổi mã PIN Phụ huynh thành công!", "vi-VN");
      }
    });

    document.getElementById("set-brightness").addEventListener("input", e => {
      state.config.brightness = parseInt(e.target.value, 10);
      document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
      saveLocalState();
      if (getRobotNative()) getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
    });

    document.getElementById("set-volume").addEventListener("input", e => {
      state.config.volume = parseInt(e.target.value, 10);
      document.getElementById("val-volume").textContent = `${state.config.volume}%`;
      saveLocalState();
      if (getRobotNative()) getRobotNative().setVolume({ level: state.config.volume }).catch(() => {});
    });

    document.getElementById("set-rate").addEventListener("input", e => {
      state.config.speechRate = parseFloat(e.target.value);
      document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
      saveLocalState();
    });

    document.getElementById("btn-req-perms").addEventListener("click", () => {
      if (getRobotNative()) getRobotNative().requestAllPermissions().catch(() => {});
    });

    document.getElementById("btn-open-wifi").addEventListener("click", () => {
      if (getRobotNative()) getRobotNative().openWifiSettings().catch(() => {});
    });

    document.getElementById("btn-ble-scan").addEventListener("click", scanAndConnectBle);
    document.getElementById("btn-test-head-light").addEventListener("click", () => {
      const next = !state.headLightOn;
      setHeadLight(next);
      sendBleCommand(next ? "L:HEAD_ON" : "L:HEAD_OFF");
    });
    document.getElementById("btn-test-arm-light").addEventListener("click", () => {
      const next = !state.armLightOn;
      setArmLight(next);
      sendBleCommand(next ? "L:ARM_ON" : "L:ARM_OFF");
    });
    document.getElementById("btn-test-head-turn").addEventListener("click", () => executeHeadSweep(2));

    document.getElementById("btn-save-server").addEventListener("click", () => {
      const url = document.getElementById("set-base-url").value.trim();
      if (url) {
        state.config.baseUrl = url;
        saveLocalState();
        loadTopicsList(true);
        speakFeedback("Đã lưu địa chỉ máy chủ mới!", "vi-VN");
      }
    });

    // Camera On-Demand Preview (Tắt mặc định để mát máy)
    document.getElementById("btn-toggle-cam-preview").addEventListener("click", async () => {
      const videoEl = document.getElementById("cam-preview-video");
      if (state.camStream) {
        state.camStream.getTracks().forEach(t => t.stop());
        state.camStream = null;
        videoEl.classList.add("hidden");
        return;
      }
      try {
        state.camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        videoEl.srcObject = state.camStream;
        videoEl.classList.remove("hidden");
      } catch (_) {}
    });

    // Developer Kiosk Pin / Check / Unlock
    document.getElementById("btn-dev-lock").addEventListener("click", lockDeveloperKiosk);
    document.getElementById("btn-check-pin-status").addEventListener("click", checkKioskPinStatus);
    document.getElementById("btn-dev-unlock").addEventListener("click", unlockDeveloperKioskExit);

    // Native Listeners (Zero-Beep Mic & TTS Echo Guard)
    if (getRobotNative()) {
      getRobotNative().addListener("ttsStart", () => {
        state.isSpeaking = true;
        setRobotMood("speaking");
      });
      getRobotNative().addListener("ttsEnd", () => onSpeechFinished());
      getRobotNative().addListener("speechPartial", data => {
        if (data?.text) {
          document.getElementById("user-heard-line").textContent = `👂 Nghe thoáng: "${data.text}"`;
        }
      });
      getRobotNative().addListener("speechResult", data => {
        state.isListening = false;
        handleVoiceTranscript(data?.text || "");
        setTimeout(() => ensureAlwaysListening(), 250);
      });
      getRobotNative().addListener("speechError", () => {
        state.isListening = false;
        setTimeout(() => ensureAlwaysListening(), 400);
      });
    }
  }

  async function initApp() {
    if (window.__robot2027Initialized) return;
    window.__robot2027Initialized = true;

    loadLocalState();
    updateHeaderMemberUI();
    bindEvents();
    startNaturalBlinkLoop();
    startIdleMonitor();

    refreshDeviceTelemetry();
    setInterval(refreshDeviceTelemetry, 10000);

    const native = getRobotNative();
    if (native) {
      await native.requestAllPermissions().catch(() => {});
      await native.setBrightness({ level: state.config.brightness }).catch(() => {});
      await native.setVolume({ level: state.config.volume }).catch(() => {});
    }

    syncMemberProfileServer(getActiveMember());
    loadTopicsList(false);
    ensureAlwaysListening();
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
