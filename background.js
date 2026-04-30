'use strict';

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !chrome.sidePanel?.open) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
