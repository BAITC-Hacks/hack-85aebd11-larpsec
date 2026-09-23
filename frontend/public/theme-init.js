(function () {
  var theme = 'light';
  try {
    if (localStorage.getItem('larpsec.theme') === 'dark') theme = 'dark';
  } catch (_) { /* Theme switching also works when storage is unavailable. */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}());
