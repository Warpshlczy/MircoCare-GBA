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
  | "dailyCheckIn"
  | "typeHere"
  | "send"
  | "voiceUnavailable"
  | "todoSaved"
  | "noSpeech"
  | "toolsOpened"
  | "highContrast"
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
  | "screeningSeconds";

type Dict = Record<MsgKey, string>;

const zhHK: Dict = {
  greeting: "阿婆／阿伯你好，我係靈犀，有事隨時叫我。",
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
  sleeping: "守護緊，叫聲「靈犀」我就應你。",
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
  dailyCheckIn: "阿婆／阿伯，早晨呀，今日精神點？有冇邊度唔舒服？",
  typeHere: "喺度打字",
  send: "傳送",
  voiceUnavailable: "呢度用唔到語音，可以用返下面啲掣。",
  todoSaved: "好，幫你記低咗。",
  noSpeech: "聽唔到你把聲，再講多次？",
  toolsOpened: "好，啲掣開咗，你想用邊個就撳。",
  highContrast: "高對比",
  langOther: "普通話",
  wakeGreeting: "阿婆／阿伯，我喺度。今日身體點呀？有冇邊度唔舒服？",
  openGreeting: "阿婆／阿伯，我係靈犀。今日身體點呀？有冇邊度唔舒服？",
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
  assistantTitle: "靈犀講",
  medPlanSaved: "好，已經幫你記低用藥計劃。",
  screeningTitle: "語音篩查",
  screeningPrompt: "請隨便講一分鐘，講乜都得，我幫你記錄。",
  screeningRecording: "錄緊音…",
  screeningSaving: "儲存緊…",
  screeningDone: "記錄好喇，多謝你。",
  screeningFailed: "今次記錄唔到，遲啲再試。",
  screeningClose: "返回",
  screeningSeconds: "秒",
};

const zhCN: Dict = {
  greeting: "奶奶／爷爷您好，我是灵犀，有事随时叫我。",
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
  sleeping: "守护中，叫一声「灵犀」我就应您。",
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
  dailyCheckIn: "奶奶／爷爷，早上好，今天感觉怎么样？有没有哪里不舒服？",
  typeHere: "在这里打字",
  send: "发送",
  voiceUnavailable: "这里用不了语音，可以用回下面的按钮。",
  todoSaved: "好，帮您记下了。",
  noSpeech: "听不到您的声音，再说一次？",
  toolsOpened: "好，按钮打开了，您想用哪个就点。",
  highContrast: "高对比",
  langOther: "粤语",
  wakeGreeting: "奶奶／爷爷，我在呢。今天身体怎么样？有没有哪里不舒服？",
  openGreeting: "奶奶／爷爷，我是灵犀。今天身体怎么样？有没有哪里不舒服？",
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
  assistantTitle: "灵犀说",
  medPlanSaved: "好，已经帮您记录用药计划。",
  screeningTitle: "语音筛查",
  screeningPrompt: "请随便讲一分钟，讲什么都可以，我帮您记录。",
  screeningRecording: "正在录音…",
  screeningSaving: "正在保存…",
  screeningDone: "记录好了，谢谢您。",
  screeningFailed: "这次没有记录成功，稍后再试。",
  screeningClose: "返回",
  screeningSeconds: "秒",
};

const DICTS: Record<string, Dict> = {
  "zh-HK": zhHK,
  "zh-MO": zhHK,
  "zh-CN": zhCN,
};

export function t(locale: string, key: MsgKey): string {
  return (DICTS[locale] ?? zhCN)[key];
}