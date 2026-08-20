'use strict';

function renderHelpPopupHtml() {
  const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
    .map((d) => `<span class="wui-help__handle wui-help__handle--${d}" data-resize="${d}"></span>`)
    .join('');

  return `
    <div id="wui-help" class="wui-help" hidden>
      <div class="wui-help__win" role="dialog" aria-modal="false" aria-labelledby="wui-help-title">
        ${handles}
        <header class="wui-help__bar" data-drag="1">
          <span class="wui-help__title" id="wui-help-title">도움말</span>
          <label class="wui-help__opacity">
            <span class="wui-help__opacity-val" id="wui-help-opacity-val">85%</span>
            <input type="range" id="wui-help-opacity" min="40" max="100" step="1" value="85" aria-label="창 투명도">
          </label>
          <button type="button" class="wui-help__btn" id="wui-help-min" title="접기" aria-label="접기">−</button>
          <button type="button" class="wui-help__btn" id="wui-help-close" title="닫기" aria-label="닫기">×</button>
        </header>
        <div class="wui-help__body" id="wui-help-body"
             hx-get="/partials/help"
             hx-trigger="wui-help-open from:body"
             hx-swap="innerHTML"
             hx-disabled-elt="this">
        </div>
      </div>
    </div>`;
}

module.exports = { renderHelpPopupHtml };
