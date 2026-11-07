// Runs before styles and React to keep the first paint on the saved theme.
(() => {
  let preference = 'system'
  try {
    const stored = localStorage.getItem('owngate.theme')
    if (stored === 'light' || stored === 'dark') preference = stored
  } catch { /* Storage can be disabled by the browser. */ }
  document.documentElement.dataset.theme = preference === 'system'
    ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : preference
})()
