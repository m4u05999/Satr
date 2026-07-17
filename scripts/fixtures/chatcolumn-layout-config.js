const allowedLayoutWidths = new Set(['806', '504', '381']);
const requestedLayoutWidth = new URLSearchParams(window.location.search).get('width');

document.documentElement.dataset.layoutWidth = allowedLayoutWidths.has(requestedLayoutWidth)
  ? requestedLayoutWidth
  : '806';
