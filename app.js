// Landing-page glue:
//   1. Swap interface text into whatever language the user picks (or the
//      browser defaults to), saved in localStorage so repeat visits don't
//      re-detect from Accept-Language every time.
//   2. Fetch the latest release from the shroud-releases repo and point
//      the Download button at the right installer. This keeps the landing
//      page honest without needing a rebuild every version bump.

const LANG_KEY = "shroud.landing.lang";
const SUPPORTED = [
  "en", "uk", "es", "de", "fr", "pt", "pl", "tr", "zh",
];
const RELEASES_REPO = "KryneDev/shroud-releases";

function detectLang() {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored && SUPPORTED.includes(stored)) return stored;
  const nav = (navigator.language || "en").toLowerCase();
  // Ukrainian + Russian speakers get UK — historical default in the app.
  if (nav.startsWith("uk") || nav.startsWith("ru")) return "uk";
  for (const code of SUPPORTED) {
    if (nav.startsWith(code)) return code;
  }
  return "en";
}

function applyI18n(lang) {
  const dict = (window.I18N && window.I18N[lang]) || window.I18N.en;
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const text = dict[key] ?? (window.I18N.en[key] ?? key);
    el.textContent = text;
  });
  // Language-select reflects the active choice.
  const select = document.getElementById("lang-select");
  if (select) select.value = lang;
}

function setupLangSelector() {
  const select = document.getElementById("lang-select");
  if (!select) return;
  select.addEventListener("change", (e) => {
    const lang = e.target.value;
    if (!SUPPORTED.includes(lang)) return;
    localStorage.setItem(LANG_KEY, lang);
    applyI18n(lang);
  });
}

async function fetchLatestRelease() {
  const winBtn = document.getElementById("platform-windows");
  const winSub = document.getElementById("platform-windows-sub");
  const andBtn = document.getElementById("platform-android");
  const andSub = document.getElementById("platform-android-sub");
  const heroBtn = document.getElementById("download-primary");
  const heroVer = document.getElementById("hero-version");

  // Detect Android visitors so the hero CTA points to the APK by default.
  const isAndroid = /Android/i.test(navigator.userAgent);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const winAsset = (data.assets || []).find((a) =>
      /_x64-setup\.exe$/i.test(a.name),
    );
    // APK naming is currently "Shroud_<ver>_universal.apk" or similar —
    // match anything ending in .apk so we don't bind to a strict pattern.
    const apkAsset = (data.assets || []).find((a) => /\.apk$/i.test(a.name));

    const releasesPage = data.html_url || `https://github.com/${RELEASES_REPO}/releases`;
    if (winBtn) winBtn.href = winAsset?.browser_download_url ?? releasesPage;
    if (andBtn) andBtn.href = apkAsset?.browser_download_url ?? releasesPage;

    // Hero button: pick the binary for the visitor's device. Falls back to
    // the Windows installer (still the default platform) if no APK is
    // available, then to the releases page if that's also missing.
    const heroAsset =
      isAndroid && apkAsset
        ? apkAsset
        : winAsset ?? apkAsset;
    if (heroBtn) heroBtn.href = heroAsset?.browser_download_url ?? releasesPage;

    // Switch the hero button label when we're sending the visitor to Android.
    if (isAndroid && apkAsset) {
      const heroLabel = document.getElementById("download-label");
      if (heroLabel) heroLabel.textContent = heroLabel.dataset.androidLabel || "Download for Android";
    }

    const version = data.tag_name?.replace(/^v/, "") || data.name || "";
    if (version) {
      if (winSub) winSub.textContent = `v${version}`;
      if (andSub) andSub.textContent = apkAsset ? `v${version}` : andSub.textContent;
      if (heroVer) heroVer.textContent = `v${version}`;
    }
  } catch (err) {
    console.warn("release fetch failed:", err);
    const fallback = `https://github.com/${RELEASES_REPO}/releases`;
    if (winBtn) winBtn.href = fallback;
    if (andBtn) andBtn.href = fallback;
    if (heroBtn) heroBtn.href = fallback;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applyI18n(detectLang());
  setupLangSelector();
  fetchLatestRelease();
});
