'use strict';

const NAADIR_YOUTUBE_GEMINI_SUMMARISER_VERSION = '2.0.0';

if (window.__naadirYoutubeGeminiSummariserVersion !== NAADIR_YOUTUBE_GEMINI_SUMMARISER_VERSION) {
  window.__naadirYoutubeGeminiSummariserVersion = NAADIR_YOUTUBE_GEMINI_SUMMARISER_VERSION;

  const GEMINI_SELECTORS = {
    button: '#flexible-item-buttons > yt-button-view-model > button-view-model > button',
    textarea: '#footer > yt-chat-input-view-model > div > form > textarea',
    responseParagraph: '#contents you-chat-item-view-model markdown-div p',
    responseItem: '#contents you-chat-item-view-model',
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === 'getVideoMeta' || msg?.action === 'getVideoMetaV2') {
      sendResponse({ ok: true, data: getVideoMeta() });
      return true;
    }

    if (msg?.action === 'runGeminiPrompt' || msg?.action === 'runGeminiPromptV2') {
      runGeminiPrompt(String(msg.prompt || ''))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }

    return false;
  });

  function getVideoMeta() {
    const url = new URL(location.href);
    const videoId = url.searchParams.get('v') || '';
    const title =
      textFrom('h1.ytd-watch-metadata yt-formatted-string') ||
      textFrom('h1.ytd-watch-metadata') ||
      cleanTitle(document.title);
    const channel =
      textFrom('ytd-video-owner-renderer #channel-name a') ||
      textFrom('#owner #channel-name a') ||
      textFrom('ytd-channel-name a');

    return {
      title: title || 'Untitled YouTube video',
      channel: channel || 'YouTube',
      url: location.href,
      videoId,
      thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '',
      favicon: 'https://www.google.com/s2/favicons?domain=www.youtube.com&sz=32',
    };
  }

  async function runGeminiPrompt(promptText) {
    if (!promptText.trim()) {
      throw new Error('Prompt is empty');
    }

    const beforeSnapshot = getResponseSnapshot(promptText);

    let textarea = document.querySelector(GEMINI_SELECTORS.textarea);

    if (!textarea) {
      const button = document.querySelector(GEMINI_SELECTORS.button);
      if (!button) {
        throw new Error('Gemini summary button not found on this YouTube page');
      }

      clickElement(button);
      textarea = await waitForSelector(GEMINI_SELECTORS.textarea, 12000);
    }

    if (!textarea) {
      throw new Error('Gemini prompt box did not open');
    }

    textarea.focus();
    setTextareaValue(textarea, promptText);
    dispatchEnter(textarea);

    await sleep(3500);

    let responseText = null;
    let lastText = '';
    let stableCount = 0;

    for (let i = 0; i < 90; i++) {
      const currentText = getLatestResponseText(beforeSnapshot, promptText);
      const looksNew = Boolean(currentText);

      if (looksNew && currentText !== lastText) {
        lastText = currentText;
        stableCount = 0;
      } else if (looksNew && currentText === lastText) {
        stableCount += 1;
      }

      if (lastText && stableCount >= 3) {
        responseText = lastText;
        break;
      }

      await sleep(1000);
    }

    if (!responseText) {
      throw new Error('Gemini response was not found or did not finish in time');
    }

    return {
      responseText,
      meta: getVideoMeta(),
    };
  }

  function getResponseSnapshot(promptText) {
    const candidates = getResponseCandidates(promptText);

    return {
      itemCount: document.querySelectorAll(GEMINI_SELECTORS.responseItem).length,
      texts: new Set(candidates.map((candidate) => candidate.text)),
    };
  }

  function getLatestResponseText(beforeSnapshot, promptText) {
    const candidates = getResponseCandidates(promptText);
    const freshCandidates = candidates.filter((candidate) =>
      candidate.index >= beforeSnapshot.itemCount ||
      !beforeSnapshot.texts.has(candidate.text)
    );
    const latestFresh = freshCandidates.at(-1);

    return latestFresh?.text || null;
  }

  function getResponseCandidates(promptText) {
    const items = Array.from(document.querySelectorAll(GEMINI_SELECTORS.responseItem));

    return items
      .map((item, index) => ({
        index,
        text: extractAssistantText(item, promptText),
      }))
      .filter((candidate) => candidate.text);
  }

  function extractAssistantText(item, promptText) {
    const markdownBlocks = Array.from(item.querySelectorAll('markdown-div'));
    const blockTexts = markdownBlocks
      .map((block) => textFromMarkdownBlock(block))
      .map(normaliseResponse)
      .filter((text) => isUsableAssistantText(text, promptText));

    if (blockTexts.length) {
      return blockTexts.sort((a, b) => b.length - a.length)[0];
    }

    const itemText = normaliseResponse(item.innerText || '');
    return isUsableAssistantText(itemText, promptText) ? itemText : null;
  }

  function textFromMarkdownBlock(block) {
    const nodes = Array.from(
      block.querySelectorAll('h1, h2, h3, h4, p, li, pre, code')
    );

    if (!nodes.length) {
      return block.innerText || '';
    }

    return nodes
      .map((node) => node.innerText.trim())
      .filter(Boolean)
      .join('\n');
  }

  function isUsableAssistantText(text, promptText) {
    const normalised = normaliseResponse(text);
    if (!normalised || normalised.length < 40) return false;
    if (isPromptEcho(normalised, promptText)) return false;
    if (isLikelyFollowUpQuestionSet(normalised)) return false;
    return true;
  }

  function isPromptEcho(text, promptText) {
    const compactText = text.replace(/\s+/g, ' ').trim();
    const compactPrompt = String(promptText || '').replace(/\s+/g, ' ').trim();

    return (
      compactPrompt.includes(compactText) ||
      compactText.includes('Respond in this exact format:') ||
      compactText.includes('Extract the practical value from this YouTube video.') ||
      compactText.includes('Analyze this YouTube video like a skeptical research assistant.')
    );
  }

  function isLikelyFollowUpQuestionSet(text) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) return false;

    const questionLines = lines.filter((line) => /\?\s*$/.test(line));
    const allShortQuestions =
      lines.length <= 6 &&
      questionLines.length >= Math.max(2, lines.length - 1) &&
      text.length < 500;

    const singleSuggestion = lines.length === 1 && questionLines.length === 1 && text.length < 180;

    return allShortQuestions || singleSuggestion;
  }

  function waitForSelector(selector, timeoutMs) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) {
        resolve(found);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(element);
        }
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);

      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function setTextareaValue(textarea, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    );

    if (descriptor?.set) {
      descriptor.set.call(textarea, value);
    } else {
      textarea.value = value;
    }

    try {
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value,
      }));
    } catch {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dispatchEnter(textarea) {
    const eventOptions = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };

    textarea.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
    textarea.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
  }

  function clickElement(element) {
    const options = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    element.dispatchEvent(new MouseEvent('mousedown', options));
    element.dispatchEvent(new MouseEvent('mouseup', options));
    element.click();
  }

  function textFrom(selector) {
    return document.querySelector(selector)?.innerText?.replace(/\s+/g, ' ').trim() || '';
  }

  function cleanTitle(title) {
    return String(title || '')
      .replace(/\s+-\s+YouTube$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normaliseResponse(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
