// Day details on hover (tap on touch screens), and the Get updates dialog.
(() => {
  const tip = document.querySelector(".tip");
  const toast = document.querySelector(".toast");

  function showTip(day) {
    const [date, detail] = day.dataset.tip.split(" · ");
    tip.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = date;
    const span = document.createElement("span");
    span.textContent = day.dataset.note ? `${detail} · ${day.dataset.note}` : detail;
    tip.append(strong, span);
    tip.hidden = false;
    const box = day.getBoundingClientRect();
    const width = tip.offsetWidth;
    const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, box.top - tip.offsetHeight - 8)}px`;
  }
  const hideTip = () => (tip.hidden = true);

  for (const day of document.querySelectorAll(".bars .day")) {
    day.addEventListener("mouseenter", () => showTip(day));
    day.addEventListener("focus", () => showTip(day));
    day.addEventListener("mouseleave", hideTip);
    day.addEventListener("blur", hideTip);
    day.addEventListener("touchstart", () => showTip(day), { passive: true });
  }
  window.addEventListener("scroll", hideTip, { passive: true });

  const dialog = document.getElementById("updates");
  document.querySelector("[data-open=updates]").addEventListener("click", () => dialog.showModal());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  for (const tab of dialog.querySelectorAll("[data-tab]")) {
    tab.addEventListener("click", () => {
      for (const t of dialog.querySelectorAll("[data-tab]")) t.setAttribute("aria-selected", String(t === tab));
      for (const p of dialog.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
  }

  let timer;
  function say(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => (toast.hidden = true), 2500);
  }
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        say("Copied");
      } catch {
        say("Select the text to copy it");
      }
    });
  }
})();
