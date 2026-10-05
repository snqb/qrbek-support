const sourceBankList = (banks) =>
  (banks || []).filter((bank) => bank.allowAsSource !== false);

const makeBankLink = (bank, text = bank.name) => {
  const link = document.createElement("a");
  link.className = "source-bank-logo source-bank-link";
  link.dataset.bankId = bank.id;
  link.setAttribute("aria-disabled", "true");
  link.tabIndex = -1;
  const image = document.createElement("img");
  image.src = bank.icon;
  image.alt = "";
  image.width = 32;
  image.height = 32;
  const label = document.createElement("span");
  label.textContent = text;
  link.append(image, label);
  return link;
};

/** Remove controls before starting a new recipient/amount preparation. */
export function clearReceiverBankLinks(container) {
  container?.replaceChildren();
}

/**
 * Prepare direct bank URLs. Links have no href while work is pending, so a
 * previous recipient can never remain actionable during an async transition.
 */
export function prepareReceiverBankLinks({
  container,
  banks,
  inspected,
  directTarget,
  getTarget,
  isCurrent,
  onError,
}) {
  clearReceiverBankLinks(container);
  if (!container || !inspected || !isCurrent()) return Promise.resolve();

  if (inspected.kind === "sbp") {
    const link = makeBankLink({
      id: "sbp",
      name: "СБП",
      icon: "/assets/mark.png",
    }, "Открыть ссылку ↗");
    if (directTarget?.url) {
      link.href = directTarget.url;
      link.removeAttribute("aria-disabled");
      link.tabIndex = 0;
    }
    container.append(link);
    return Promise.resolve();
  }

  const candidates = sourceBankList(banks);
  const links = candidates.map((bank) => {
    const link = makeBankLink(bank);
    container.append(link);
    return { bank, link };
  });
  if (!links.length) {
    onError?.("Нет доступного банка для оплаты.");
    return Promise.resolve();
  }

  return Promise.allSettled(links.map(({ bank }) => getTarget(bank.id))).then(
    (results) => {
      if (!isCurrent()) return;
      let ready = 0;
      results.forEach((result, index) => {
        const { link } = links[index];
        if (result.status === "fulfilled" && result.value?.url) {
          link.href = result.value.url;
          link.removeAttribute("aria-disabled");
          link.tabIndex = 0;
          ready += 1;
        } else {
          link.remove();
        }
      });
      if (!ready) onError?.("Не удалось подготовить ссылку для оплаты.");
    },
  );
}
