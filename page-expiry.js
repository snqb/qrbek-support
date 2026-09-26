export function expiryTimestamp(value) {
  if (typeof value !== "string") throw new Error("Сервер не указал срок ссылки.");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Некорректный срок ссылки.");
  return timestamp;
}

export function formatExpiry(value) {
  return `Действует до ${new Intl.DateTimeFormat("ru", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(expiryTimestamp(value))}`;
}

/** Recheck on foreground/BFCache restoration as browser timers can be suspended. */
export function watchPageExpiry(value, onExpired) {
  const deadline = expiryTimestamp(value);
  let timer;
  let expired = false;
  const check = () => {
    if (expired) return true;
    clearTimeout(timer);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      expired = true;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
      onExpired();
      return true;
    }
    timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    return false;
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("pageshow", check);
  check();
  return check;
}
