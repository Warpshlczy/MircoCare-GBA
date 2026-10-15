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
  | "openGreeting";

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
  sosCancel: "撳錯咗？撳呢度取消。",
  caregiverEscalation: "等咗咁耐都冇回應，我已經通知咗你屋企人同社區照顧員。",
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
  sosCancel: "点错了？点这里取消。",
  caregiverEscalation: "等了这么久没回应，我已经通知了您的家人和社区照护员。",
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
};

const DICTS: Record<string, Dict> = {
  "zh-HK": zhHK,
  "zh-MO": zhHK,
  "zh-CN": zhCN,
};

export function t(locale: string, key: MsgKey): string {
  return (DICTS[locale] ?? zhCN)[key];
}