// Tiny hand-rolled dictionary — NOT an i18n library. Two real written forms:
// zh-HK (Cantonese-flavoured, e.g. 「食藥」「陣間」) and zh-CN (Mandarin).
// zh-MO reuses the Cantonese wording (Macao reads the same written Cantonese).

export type MsgKey =
  | "greeting"
  | "medReminder"
  | "medConfirm"
  | "medTaken"
  | "medSnooze"
  | "nfcTapHint"
  | "nfcScanning"
  | "nfcUnavailable"
  | "sosConfirmQuestion"
  | "sosDialing"
  | "sosSending"
  | "sosRecorded"
  | "sosNotified"
  | "sosNoFamily"
  | "sosFailed"
  | "sosRetry"
  | "sosCallEmergency"
  | "sosCancel"
  | "caregiverEscalation"
  | "healthCardTitle"
  | "talkButton"
  | "sosButton"
  | "listening"
  | "thinking"
  | "speaking"
  | "confirmYes"
  | "confirmNo"
  | "reminderTitle"
  | "fallDetected"
  | "sleeping"
  | "wakeOn"
  | "wakeListening"
  | "weatherTitle"
  | "tasksTitle"
  | "cameraTitle"
  | "cameraShutter"
  | "cameraClose"
  | "cameraUnavailable"
  | "cardEmpty"
  | "intentUnknown"
  | "photoTaken"
  | "typeHere"
  | "send"
  | "voiceUnavailable"
  | "todoSaved"
  | "noSpeech"
  | "toolsOpened"
  | "langOther"
  | "wakeGreeting"
  | "openGreeting"
  | "cancel"
  | "followupTitle"
  | "followupConfirm"
  | "followupDone"
  | "followupEscalation"
  | "followupFormTitle"
  | "followupFormLabel"
  | "followupFormWhen"
  | "followupSave"
  | "followupInvalid"
  | "followupPrompt"
  | "followupCardTitle"
  | "reminderWhen"
  | "noteSavedTitle"
  | "noteRecallTitle"
  | "noteEmpty"
  | "noteTime"
  | "noteHint"
  | "assistantTitle"
  | "medPlanSaved"
  | "screeningTitle"
  | "screeningPrompt"
  | "screeningRecording"
  | "screeningSaving"
  | "screeningDone"
  | "screeningFailed"
  | "screeningClose"
  | "screeningSeconds"
  | "appName"
  | "avatarHint"
  | "wakeHint"
  | "wakeHintSpoken"
  | "longPressPrompt"
  | "cancelled"
  | "interviewIntro"
  | "interviewAck"
  | "interviewRepeat"
  | "interviewSkip"
  | "interviewDone"
  | "interviewRefused"
  | "interviewTired"
  | "careSad"
  | "careLost"
  | "silenceCare"
  | "quickTitle"
  | "quickMed"
  | "quickToday"
  | "quickCallFamily"
  | "toolsClose"
  | "displayMode"
  | "displayStandard"
  | "displayHc"
  | "displayLarge"
  | "riskLow"
  | "riskWatch"
  | "riskElevated"
  | "riskInsufficient";

type Dict = Record<MsgKey, string>;

const zhHK: Dict = {
  greeting: "阿婆／阿伯你好，我係憶伴，有事隨時叫我。",
  medReminder: "夠鐘食藥喇，記得食埋枱面嗰盒藥。",
  medConfirm: "你食咗藥未呀？食咗就撳一撳，或者攞個藥盒碰一碰。",
  medTaken: "好，知道喇，已幫你記低。",
  medSnooze: "得，陣間再提你。",
  nfcTapHint: "攞個藥盒喺手機背面碰一碰，就當打卡。",
  nfcScanning: "等一等，聽緊藥盒…",
  nfcUnavailable: "呢部手機冇碰一碰，撳下面個大掣都得。",
  sosConfirmQuestion: "你係咪唔舒服？需要我幫你嗌人嗎？",
  sosDialing: "好，我即刻幫你通知屋企人同社區照顧員。",
  sosSending: "正在發出求助…",
  sosRecorded: "求助已記錄。如情況緊急，請直接打 999。",
  sosNotified: "求助已記錄，已通知屋企人同社區照顧員。如情況緊急，請直接打 999。",
  sosNoFamily: "求助已記錄。但仲未綁定屋企人，請家人先配對，或直接打 999。",
  sosFailed: "網絡未接通，求助未發出。請再試，或直接打 999。",
  sosRetry: "再試一次",
  sosCallEmergency: "打 999",
  sosCancel: "撳錯咗？撳呢度取消。",
  caregiverEscalation: "等咗咁耐都冇回應，我已經記錄咗呢次超時。請你即刻食藥。",
  healthCardTitle: "跨境健康卡",
  talkButton: "講嘢",
  sosButton: "求助",
  listening: "聽緊你講…",
  thinking: "諗緊…",
  speaking: "講緊嘢…",
  confirmYes: "係",
  confirmNo: "唔係",
  reminderTitle: "食藥提醒",
  fallDetected: "好似跌親，要唔要幫你嗌人？",
  sleeping: "守護緊，叫聲「小憶」我就應你。",
  wakeOn: "開語音喚醒",
  wakeListening: "聽緊你叫我…",
  weatherTitle: "今日天氣",
  tasksTitle: "今日要做嘅事",
  cameraTitle: "影相",
  cameraShutter: "影",
  cameraClose: "唔影喇",
  cameraUnavailable: "呢部手機開唔到相機，撳下面個掣返去。",
  cardEmpty: "暫時冇嘢要提你。",
  intentUnknown: "我未聽清楚，再講多次？",
  photoTaken: "相影好喇。",
  typeHere: "喺度打字",
  send: "傳送",
  voiceUnavailable: "呢度用唔到語音，可以用返下面啲掣。",
  todoSaved: "好，幫你記低咗。",
  noSpeech: "聽唔到你把聲，再講多次？",
  toolsOpened: "好，啲掣開咗，你想用邊個就撳。",
  langOther: "普通話",
  wakeGreeting: "阿婆／阿伯，我喺度。今日身體點呀？有冇邊度唔舒服？",
  openGreeting: "阿婆／阿伯，我係憶伴。今日身體點呀？有冇邊度唔舒服？",
  cancel: "取消",
  followupTitle: "覆診提醒",
  followupConfirm: "夠鐘覆診喇，記得帶健康卡。",
  followupDone: "知道喇",
  followupEscalation: "覆診時間過咗好耐，我已經記錄咗呢次超時。",
  followupFormTitle: "設定覆診提醒",
  followupFormLabel: "覆診做咩",
  followupFormWhen: "幾時",
  followupSave: "記低",
  followupInvalid: "請揀一個將來嘅時間。",
  followupPrompt: "好，請設定覆診時間。",
  followupCardTitle: "覆診提醒已記低",
  reminderWhen: "提醒時間",
  noteSavedTitle: "幫你記低咗",
  noteRecallTitle: "你記低嘅事",
  noteEmpty: "暫時未有記錄。",
  noteTime: "記錄時間",
  noteHint: "講「記住…」我就會幫你記低",
  assistantTitle: "憶伴講",
  medPlanSaved: "好，已經幫你記低用藥計劃。",
  screeningTitle: "語音篩查",
  screeningPrompt: "請隨便講一分鐘，講乜都得，我幫你記錄。",
  screeningRecording: "錄緊音…",
  screeningSaving: "儲存緊…",
  screeningDone: "記錄好喇，多謝你。",
  screeningFailed: "今次記錄唔到，遲啲再試。",
  screeningClose: "返回",
  screeningSeconds: "秒",
  appName: "憶伴",
  avatarHint: "撳一下再講一次，㩒住一秒就聽你講",
  wakeHint: "叫我「小憶」，或者撳「講嘢」",
  wakeHintSpoken: "你叫我一聲「小憶」就得，或者撳下面個大掣。",
  longPressPrompt: "你想講咩？",
  cancelled: "好，唔做住。",
  interviewIntro: "我哋傾幾句偈好唔好？唔想講隨時話我知。",
  interviewAck: "嗯，好。",
  interviewRepeat: "慢慢諗，唔使急。",
  interviewSkip: "唔緊要，我哋講第二樣。",
  interviewDone: "多謝你同我傾偈，今日講到呢度，有事隨時叫我。",
  interviewRefused: "好，唔講住，你想講嘅時候再叫我。",
  interviewTired: "辛苦晒，你休息下先，我喺度陪住你。",
  careSad: "我喺度陪住你，想講就慢慢講。",
  careLost: "唔緊要，慢慢搵。如果之前叫我記低過，你可以問我「我記低咗咩」。",
  silenceCare: "阿婆／阿伯，兩日冇聽到你把聲，掛住你呀。今日點呀？",
  quickTitle: "常用",
  quickMed: "食藥",
  quickToday: "今日安排",
  quickCallFamily: "打畀屋企人",
  toolsClose: "收埋",
  displayMode: "顯示",
  displayStandard: "標準",
  displayHc: "高對比",
  displayLarge: "大字",
  riskLow: "一切如常",
  riskWatch: "值得留意",
  riskElevated: "建議檢查",
  riskInsufficient: "樣本不足，繼續觀察",
};

const zhCN: Dict = {
  greeting: "奶奶／爷爷您好，我是忆伴，有事随时叫我。",
  medReminder: "到点吃药啦，记得把桌上那盒药吃了。",
  medConfirm: "您吃药了吗？吃了就点一下，或者拿药盒来碰一碰。",
  medTaken: "好，知道啦，已经帮您记下了。",
  medSnooze: "好的，等会儿再提醒您。",
  nfcTapHint: "把药盒在手机背面碰一碰，就算打卡。",
  nfcScanning: "稍等，正在听药盒…",
  nfcUnavailable: "这台手机没有碰一碰，点下面的大按钮也可以。",
  sosConfirmQuestion: "您是不是不舒服？需要我帮您叫人吗？",
  sosDialing: "好，我马上帮您通知家人和社区照护员。",
  sosSending: "正在发出求助…",
  sosRecorded: "求助已记录。如情况紧急，请直接拨打 120。",
  sosNotified: "求助已记录，已通知家人和社区照护员。如情况紧急，请直接拨打 120。",
  sosNoFamily: "求助已记录。但还没有绑定家人，请家人先配对，或直接拨打 120。",
  sosFailed: "网络未接通，求助没有发出。请重试，或直接拨打 120。",
  sosRetry: "再试一次",
  sosCallEmergency: "拨打 120",
  sosCancel: "点错了？点这里取消。",
  caregiverEscalation: "等了这么久没回应，我已经记录了这次超时。请马上吃药。",
  healthCardTitle: "跨境健康卡",
  talkButton: "说话",
  sosButton: "求助",
  listening: "在听您说…",
  thinking: "在想…",
  speaking: "在说话…",
  confirmYes: "是",
  confirmNo: "不是",
  reminderTitle: "吃药提醒",
  fallDetected: "好像摔倒了，要帮您叫人吗？",
  sleeping: "守护中，叫一声「小忆」我就应您。",
  wakeOn: "开启语音唤醒",
  wakeListening: "正在听您叫我…",
  weatherTitle: "今日天气",
  tasksTitle: "今天要做的事",
  cameraTitle: "拍照",
  cameraShutter: "拍照",
  cameraClose: "不拍了",
  cameraUnavailable: "这台手机打不开相机，点下面的按钮返回。",
  cardEmpty: "暂时没有要提醒您的事。",
  intentUnknown: "我没听清，再说一次？",
  photoTaken: "照片拍好了。",
  typeHere: "在这里打字",
  send: "发送",
  voiceUnavailable: "这里用不了语音，可以用回下面的按钮。",
  todoSaved: "好，帮您记下了。",
  noSpeech: "听不到您的声音，再说一次？",
  toolsOpened: "好，按钮打开了，您想用哪个就点。",
  langOther: "粤语",
  wakeGreeting: "奶奶／爷爷，我在呢。今天身体怎么样？有没有哪里不舒服？",
  openGreeting: "奶奶／爷爷，我是忆伴。今天身体怎么样？有没有哪里不舒服？",
  cancel: "取消",
  followupTitle: "复诊提醒",
  followupConfirm: "到复诊时间了，记得带健康卡。",
  followupDone: "知道了",
  followupEscalation: "复诊时间过去很久了，我已经记录了这次超时。",
  followupFormTitle: "设置复诊提醒",
  followupFormLabel: "复诊事项",
  followupFormWhen: "什么时候",
  followupSave: "保存",
  followupInvalid: "请选择一个将来的时间。",
  followupPrompt: "好的，请设置复诊时间。",
  followupCardTitle: "复诊提醒已记录",
  reminderWhen: "提醒时间",
  noteSavedTitle: "帮您记下了",
  noteRecallTitle: "您记下的事",
  noteEmpty: "暂时没有记录。",
  noteTime: "记录时间",
  noteHint: "说「记住…」我就会帮您记下",
  assistantTitle: "忆伴说",
  medPlanSaved: "好，已经帮您记录用药计划。",
  screeningTitle: "语音筛查",
  screeningPrompt: "请随便讲一分钟，讲什么都可以，我帮您记录。",
  screeningRecording: "正在录音…",
  screeningSaving: "正在保存…",
  screeningDone: "记录好了，谢谢您。",
  screeningFailed: "这次没有记录成功，稍后再试。",
  screeningClose: "返回",
  screeningSeconds: "秒",
  appName: "忆伴",
  avatarHint: "点一下再说一次，按住一秒就听您说",
  wakeHint: "叫我「小忆」，或者点「说话」",
  wakeHintSpoken: "您叫我一声「小忆」就行，或者点下面的大按钮。",
  longPressPrompt: "您想说什么？",
  cancelled: "好，先不做了。",
  interviewIntro: "我们聊几句好不好？不想说随时告诉我。",
  interviewAck: "嗯，好。",
  interviewRepeat: "慢慢想，不着急。",
  interviewSkip: "没关系，我们聊别的。",
  interviewDone: "谢谢您陪我聊天，今天就聊到这里，有事随时叫我。",
  interviewRefused: "好，先不聊了，您想说的时候再叫我。",
  interviewTired: "辛苦了，您先休息一下，我在这里陪着您。",
  careSad: "我在这里陪着您，想说就慢慢说。",
  careLost: "没关系，慢慢找。如果之前让我记过，您可以问我「我记了什么」。",
  silenceCare: "奶奶／爷爷，两天没听到您的声音，挺想您的。今天怎么样？",
  quickTitle: "常用",
  quickMed: "吃药",
  quickToday: "今天安排",
  quickCallFamily: "打给家人",
  toolsClose: "收起",
  displayMode: "显示",
  displayStandard: "标准",
  displayHc: "高对比",
  displayLarge: "大字",
  riskLow: "一切如常",
  riskWatch: "值得留意",
  riskElevated: "建议检查",
  riskInsufficient: "样本不足，继续观察",
};

const DICTS: Record<string, Dict> = {
  "zh-HK": zhHK,
  "zh-MO": zhHK,
  "zh-CN": zhCN,
};

export function t(locale: string, key: MsgKey): string {
  return (DICTS[locale] ?? zhCN)[key];
}
/** The ONLY wording for a risk band (issue #3): app, weekly report and slides agree. */
export function riskBandLabel(locale: string, band: string | undefined, insufficient = false): string {
  if (insufficient || !band) return t(locale, "riskInsufficient");
  return t(locale, band === "elevated" ? "riskElevated" : band === "watch" ? "riskWatch" : "riskLow");
}
