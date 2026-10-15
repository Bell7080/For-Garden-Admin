// Shared by the public website and operations console. Native selects remain as
// form values; the visible control never opens a browser-owned popup.
const media = matchMedia("(prefers-color-scheme: dark)");
let preference = "system";
try {
  preference = localStorage.getItem("fg-theme") || "system";
} catch {}
if (!["system", "dark", "light"].includes(preference)) preference = "system";
function applyTheme() {
  const theme =
    preference === "system" ? (media.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#1a1d21" : "#f5f3eb");
  document.querySelectorAll("[data-theme-select]").forEach((select) => {
    select.value = preference;
    select.dispatchEvent(new Event("fg:sync"));
  });
}
media.addEventListener("change", applyTheme);
window.addEventListener("storage", (event) => {
  if (event.key !== "fg-theme") return;
  preference = ["system", "dark", "light"].includes(event.newValue)
    ? event.newValue
    : "system";
  applyTheme();
});
function enhance(select) {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = "true";
  const root = document.createElement("div");
  root.className = "fg-select";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "fg-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute(
    "aria-label",
    select.getAttribute("aria-label") ||
      select.labels?.[0]?.textContent ||
      select.id,
  );
  const menu = document.createElement("div");
  menu.className = "fg-select-menu";
  menu.id = `fg-options-${select.id || Math.random().toString(36).slice(2)}`;
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);
  menu.setAttribute("aria-label", trigger.getAttribute("aria-label"));
  root.append(trigger, menu);
  select.after(root);
  select.classList.add("fg-native-select");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  let active = 0;
  function sync() {
    root.hidden = select.hidden;
    trigger.disabled = select.disabled;
    active = Math.max(0, select.selectedIndex);
    trigger.textContent = select.selectedOptions[0]?.textContent || "선택";
    trigger.lang =
      select.selectedOptions[0]?.lang || document.documentElement.lang;
    menu.innerHTML = "";
    [...select.options].forEach((option, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.tabIndex = -1;
      item.id = `${menu.id}-${i}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.textContent = option.textContent;
      if (option.lang) item.lang = option.lang;
      item.disabled = option.disabled;
      item.onclick = () => choose(i);
      menu.append(item);
    });
  }
  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
  }
  function highlight() {
    [...menu.children].forEach((item, i) =>
      item.classList.toggle("is-active", i === active),
    );
    trigger.setAttribute("aria-activedescendant", `${menu.id}-${active}`);
    const item = menu.children[active];
    if (item) {
      const top = item.offsetTop,
        bottom = top + item.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top;
      else if (bottom > menu.scrollTop + menu.clientHeight)
        menu.scrollTop = bottom - menu.clientHeight;
    }
  }
  function open() {
    sync();
    menu.hidden = false;
    const box = trigger.getBoundingClientRect();
    const below = innerHeight - box.bottom,
      above = box.top;
    const upward = below < Math.min(320, menu.scrollHeight) && above > below;
    menu.style.top = upward ? "auto" : "calc(100% + 6px)";
    menu.style.bottom = upward ? "calc(100% + 6px)" : "auto";
    menu.style.maxHeight = `${Math.max(120, Math.min(320, (upward ? above : below) - 14))}px`;
    trigger.setAttribute("aria-expanded", "true");
    highlight();
  }
  function choose(i) {
    select.selectedIndex = i;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
    close();
    trigger.focus({ preventScroll: true });
  }
  trigger.onclick = () => (menu.hidden ? open() : close());
  trigger.onkeydown = (event) => {
    if (event.key === "Tab") {
      close();
      return;
    }
    if (
      !["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    if (event.key === "Escape") return close();
    if (event.key === "Enter" || event.key === " ")
      return menu.hidden ? open() : choose(active);
    if (menu.hidden) open();
    else if (event.key === "ArrowDown")
      active = (active + 1) % select.options.length;
    else if (event.key === "ArrowUp")
      active = (active - 1 + select.options.length) % select.options.length;
    if (event.key === "Home") active = 0;
    if (event.key === "End") active = select.options.length - 1;
    highlight();
  };
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) close();
  });
  select.addEventListener("fg:sync", sync);
  select.addEventListener("change", sync);
  if (select.matches("[data-theme-select]")) {
    select.value = preference;
    select.addEventListener("change", () => {
      preference = select.value;
      try {
        localStorage.setItem("fg-theme", preference);
      } catch {}
      applyTheme();
    });
  }
  const observer = new MutationObserver(sync);
  observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "disabled"],
  });
  root._cleanup = () => observer.disconnect();
  sync();
}
const observer = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.removedNodes)
      if (node instanceof Element) {
        if (node.matches(".fg-select")) node._cleanup?.();
        node
          .querySelectorAll(".fg-select")
          .forEach((root) => root._cleanup?.());
      }
    for (const node of record.addedNodes)
      if (node instanceof Element) {
        if (node.matches("select")) enhance(node);
        node.querySelectorAll("select").forEach(enhance);
      }
  }
});
document.addEventListener("pointerdown", (event) =>
  document.querySelectorAll(".fg-select").forEach((root) => {
    if (root.contains(event.target)) return;
    root.querySelector(".fg-select-menu").hidden = true;
    root
      .querySelector(".fg-select-trigger")
      .setAttribute("aria-expanded", "false");
    root
      .querySelector(".fg-select-trigger")
      .removeAttribute("aria-activedescendant");
  }),
);
observer.observe(document.body, { childList: true, subtree: true });
document.querySelectorAll("select").forEach(enhance);
applyTheme();
