if (location.pathname !== '/compare.html') {
  location.replace(`/compare.html${location.hash}`);
} else if (location.hash.startsWith('#draft=')) {
  document.querySelectorAll('[data-design-link]').forEach((link) => { link.href += location.hash; });
}
