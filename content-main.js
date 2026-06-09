/**
 * Redact-on-Record — MAIN world injector
 * Runs in the page's JavaScript context so it can intercept history mutations.
 * The isolated content script cannot touch history.pushState/replaceState directly.
 */
(function () {
  'use strict';
  const EVENT = 'ror-spa-nav';
  const fire  = () => window.dispatchEvent(new CustomEvent(EVENT));
  const wrap  = (fn) => function (...args) {
    const r = Reflect.apply(fn, this, args);
    fire();
    return r;
  };
  history.pushState    = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
})();
