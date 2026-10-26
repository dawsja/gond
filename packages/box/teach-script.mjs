/**
 * Runs in every page and frame of a bot's browser while someone shows it how
 * (added once with `addInitScript`, run again in pages already open) and
 * reports what the person does through the `__gondTeach` binding. A private
 * field (a password, a sign-in code, a card) is reported by its kind alone:
 * its value never leaves the page. It reports only while the host records;
 * between recordings the binding drops what it hears.
 */
export function teachPage() {
  if (window.__gondTeachInstalled) return;
  window.__gondTeachInstalled = true;

  const send = (event) => {
    try {
      window.__gondTeach?.(event);
    } catch {
      // The binding is gone when the page is closing.
    }
  };
  const squash = (text, n) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const byIds = (ids) =>
    squash(
      (ids || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText ?? "")
        .join(" "),
      120,
    );
  const nameOf = (el) =>
    squash(el.getAttribute("aria-label"), 120) ||
    byIds(el.getAttribute("aria-labelledby")) ||
    squash(el.innerText, 120) ||
    squash(el.value && el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) ? el.value : "", 120) ||
    squash(el.querySelector?.("img[alt]")?.alt, 120) ||
    squash(el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || "", 120);
  const fieldOf = (el) =>
    squash(el.labels?.[0]?.innerText, 80) || squash(el.getAttribute("aria-label"), 80) || byIds(el.getAttribute("aria-labelledby")) || squash(el.getAttribute("placeholder") || el.name || el.id || "", 80);
  const privateKind = (el) => {
    const type = String(el.type || "").toLowerCase();
    const auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
    const key = `${el.name || ""} ${el.id || ""}`.toLowerCase();
    if (type === "password" || auto.includes("password")) return "password";
    if (auto.includes("one-time-code") || /(otp|2fa|mfa|totp|one.?time|verification.?code|passcode|security.?code)/.test(key)) return "code";
    if (auto.startsWith("cc-") || /(card.?number|cardnum|ccnum|cvc|cvv|csc|expiry|exp.?date)/.test(key)) return "card";
    return null;
  };
  const textField = (el) => el && ((el.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type)) || el.tagName === "TEXTAREA" || el.isContentEditable);
  const ROLE = { A: "link", BUTTON: "button", SELECT: "list", SUMMARY: "button", LABEL: "label" };
  const reported = new WeakMap();

  const fill = (el) => {
    const sensitive = privateKind(el);
    const value = sensitive ? null : String(el.isContentEditable ? el.innerText : el.value).slice(0, 300);
    if (!sensitive && !value) return;
    // The same value reported twice (Enter, then the change that follows) is one step.
    if (reported.get(el) === (sensitive ?? value)) return;
    reported.set(el, sensitive ?? value);
    send(sensitive ? { kind: "fill", field: fieldOf(el), sensitive } : { kind: "fill", field: fieldOf(el), value });
  };

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const el = target.closest("a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=switch],summary,[onclick]") ?? target;
      // Clicking into a field, or onto its label, only puts the cursor there: what is typed is the step.
      const control = el.tagName === "LABEL" ? el.control : el;
      if (textField(control) || control?.tagName === "SELECT" || (control?.tagName === "INPUT" && /^(checkbox|radio|file)$/i.test(control.type))) return;
      send({ kind: "click", role: el.getAttribute("role") || ROLE[el.tagName] || "", name: nameOf(el), x: event.clientX, y: event.clientY });
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      if (el.tagName === "SELECT") return send({ kind: "select", field: fieldOf(el), value: squash(el.selectedOptions?.[0]?.innerText, 120) });
      if (el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type)) return send({ kind: "check", field: fieldOf(el) || nameOf(el.closest("label") ?? el), checked: el.checked });
      if (el.tagName === "INPUT" && el.type === "file") return send({ kind: "upload", name: [...(el.files ?? [])].map((f) => f.name).join(", ") });
      if (textField(el)) fill(el);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" || !textField(event.target) || event.target.tagName === "TEXTAREA") return;
      fill(event.target);
      send({ kind: "enter", field: fieldOf(event.target) });
    },
    true,
  );
  document.addEventListener("submit", () => send({ kind: "submit" }), true);
}
