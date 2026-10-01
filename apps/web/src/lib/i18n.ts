/**
 * Interface language. English strings are the keys (gettext style), so untranslated text simply
 * stays English. The Hindi dictionary was drafted with AI assistance and has NOT yet been
 * reviewed by a native speaker; the language picker says so. Data from sources (incident titles,
 * agency text) is never machine-translated.
 */
import { useSettings, type Lang } from "./settings";

export const LANGS: Record<Lang, { label: string; native: string; note?: string }> = {
  en: { label: "English", native: "English" },
  hi: { label: "Hindi (beta)", native: "हिन्दी (बीटा)", note: "AI-drafted translation, not yet reviewed by a native speaker. Source data stays in its original language." },
};

const HI: Record<string, string> = {
  // navigation and chrome
  Planet: "पृथ्वी",
  Board: "बोर्ड",
  Gallery: "गैलरी",
  Sources: "स्रोत",
  Health: "स्थिति",
  Ask: "पूछें",
  Watch: "निगरानी",
  Layers: "परतें",
  Live: "लाइव",
  "Search places, incidents, or try “M6+ in Japan since 2020”": "स्थान, घटनाएँ खोजें, या लिखें “M6+ in Japan since 2020”",
  "Search incidents, layers and commands": "घटनाएँ, परतें और आदेश खोजें",
  // incident stream
  "Incident stream": "घटना धारा",
  Active: "सक्रिय",
  Open: "खुली",
  All: "सभी",
  Severity: "गंभीरता",
  Latest: "नवीनतम",
  "Filter by name, country or ID": "नाम, देश या आईडी से छाँटें",
  // overview
  "Planetary state": "पृथ्वी की स्थिति",
  "Play the planet story": "पृथ्वी की कहानी चलाएँ",
  "A one-minute guided tour of what is happening now": "अभी क्या हो रहा है, उसका एक मिनट का निर्देशित दौरा",
  "active incidents": "सक्रिय घटनाएँ",
  Monitoring: "निगरानी में",
  Observations: "प्रेक्षण",
  "Signals · last 24 h": "संकेत · पिछले 24 घंटे",
  "earthquakes M2.5+": "भूकंप M2.5+",
  "fire detections": "आग की पहचान",
  "active cyclones": "सक्रिय चक्रवात",
  "By hazard": "आपदा के अनुसार",
  "Most significant now": "अभी सबसे महत्वपूर्ण",
  "Compound events": "संयुक्त घटनाएँ",
  "Recent changes": "हाल के बदलाव",
  "Source health": "स्रोतों की स्थिति",
  "Space weather": "अंतरिक्ष मौसम",
  "Historical replays": "ऐतिहासिक पुनरावृत्ति",
  Report: "रिपोर्ट",
  // incident panel
  Onset: "आरंभ",
  "Latest data": "नवीनतम आँकड़े",
  Position: "स्थिति",
  "Fly to": "वहाँ जाएँ",
  "Before / after": "पहले / बाद",
  Scenario: "परिदृश्य",
  "Watch area": "क्षेत्र पर नज़र",
  Pin: "पिन",
  Pinned: "पिन किया",
  Export: "निर्यात",
  Confidence: "विश्वसनीयता",
  "How is this determined?": "यह कैसे तय होता है?",
  Intelligence: "विश्लेषण",
  Exposure: "प्रभावित",
  Satellite: "उपग्रह",
  Links: "संबंध",
  Chronology: "घटनाक्रम",
  Context: "संदर्भ",
  "Key observations": "मुख्य प्रेक्षण",
  "Official sources": "आधिकारिक स्रोत",
  "Related incidents": "संबंधित घटनाएँ",
  Limitations: "सीमाएँ",
  "Nearby places": "आस-पास के स्थान",
  "ATLAS is a research tool, not an alerting service. Always follow official warnings and local authorities.":
    "ATLAS एक शोध उपकरण है, चेतावनी सेवा नहीं। हमेशा आधिकारिक चेतावनियों और स्थानीय प्रशासन के निर्देशों का पालन करें।",
  "Official alerts in force here": "यहाँ लागू आधिकारिक चेतावनियाँ",
  "People living nearby": "आस-पास रहने वाले लोग",
  "Buildings nearby": "आस-पास की इमारतें",
  Rivers: "नदियाँ",
  // severity and status
  Unknown: "अज्ञात",
  Minor: "मामूली",
  Moderate: "मध्यम",
  Significant: "महत्वपूर्ण",
  Severe: "गंभीर",
  Extreme: "अत्यंत गंभीर",
  active: "सक्रिय",
  monitoring: "निगरानी में",
  closed: "समाप्त",
  // hazards
  Earthquake: "भूकंप",
  Earthquakes: "भूकंप",
  "Tropical cyclone": "उष्णकटिबंधीय चक्रवात",
  Cyclones: "चक्रवात",
  Wildfire: "जंगल की आग",
  Wildfires: "जंगल की आग",
  Flood: "बाढ़",
  Floods: "बाढ़",
  "Volcanic activity": "ज्वालामुखी गतिविधि",
  Volcanoes: "ज्वालामुखी",
  Drought: "सूखा",
  Droughts: "सूखा",
  "Severe storm": "भीषण तूफ़ान",
  Storms: "तूफ़ान",
  Tsunami: "सुनामी",
  Tsunamis: "सुनामी",
  Landslide: "भूस्खलन",
  Landslides: "भूस्खलन",
  "Extreme heat": "भीषण गर्मी",
  "Heat events": "गर्मी की घटनाएँ",
  "Extreme cold": "भीषण ठंड",
  "Cold events": "ठंड की घटनाएँ",
  "Air quality": "वायु गुणवत्ता",
  Other: "अन्य",
  // measure and right-click
  Measure: "मापें",
  Distance: "दूरी",
  Area: "क्षेत्रफल",
  "What's here": "यहाँ क्या है",
  Elevation: "ऊँचाई",
  "Watch this area": "इस क्षेत्र पर नज़र रखें",
  "Measure from here": "यहाँ से मापें",
  // India
  India: "भारत",
  "India view": "भारत दृश्य",
};

function lang(): Lang {
  return useSettings.getState().lang;
}

/** Translate an interface string (falls back to English). */
export function t(text: string): string {
  return lang() === "hi" ? (HI[text] ?? text) : text;
}

/** Subscribe a component to language changes. */
export function useLang(): Lang {
  return useSettings((s) => s.lang);
}

export function translated(text: string): boolean {
  return text in HI;
}
