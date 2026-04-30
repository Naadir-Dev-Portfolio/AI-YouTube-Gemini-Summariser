'use strict';

const STORAGE_KEY = 'youtubeGeminiSummaries';
const REFRESH_INTERVAL_MS = 2500;

const PROMPTS = {
  brief: {
    label: 'Brief',
    icon: '3',
    className: 'prompt-btn--brief',
    prompt: `Summarize this YouTube video for someone who does not want to watch the full video.

Respond in this exact format:

3-SENTENCE SUMMARY
Write exactly 3 concise sentences.

MAIN THESIS
State the central argument or purpose of the video in one sentence.

WATCH / SKIM / SKIP
Choose one: Watch, Skim, or Skip. Then give a one-sentence reason.`,
  },
  takeaways: {
    label: 'Takeaways',
    icon: 'K',
    className: 'prompt-btn--takeaways',
    prompt: `Extract the practical value from this YouTube video.

Respond in this exact format:

MAIN THESIS
One sentence.

KEY POINTS
List 5-8 bullet points that capture the most useful ideas.

ACTIONABLE TAKEAWAYS
List anything I could apply, remember, research, or decide because of this video.

WHAT MATTERS MOST
Give the single highest-value insight from the video.`,
  },
  claims: {
    label: 'Claims/Data',
    icon: '#',
    className: 'prompt-btn--claims',
    prompt: `Analyze this YouTube video like a skeptical research assistant.

Respond in this exact format:

IMPORTANT CLAIMS
List the main claims the video makes.

DATA POINTS AND EVIDENCE
List any numbers, dates, sources, studies, examples, or evidence mentioned. If evidence is thin, say so.

CAVEATS
List missing context, assumptions, weak claims, or things worth verifying.

WATCH / SKIM / SKIP
Choose one: Watch, Skim, or Skip. Then give a one-sentence reason.`,
  },
};

const PROMPT_ORDER = ['brief', 'takeaways', 'claims'];

let entries = [];
let currentVideo = null;
let expandedId = null;
let activeRun = null;
let refreshTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  await loadEntries();
  bindEvents();
  await refreshActiveVideo();
  render();
  refreshTimer = setInterval(refreshActiveVideo, REFRESH_INTERVAL_MS);
});

window.addEventListener('unload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});

async function loadEntries() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  entries = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY].map(normalizeEntry) : [];
}

async function saveEntries() {
  await chrome.storage.local.set({ [STORAGE_KEY]: entries });
}

function bindEvents() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    entries = Array.isArray(changes[STORAGE_KEY].newValue)
      ? changes[STORAGE_KEY].newValue.map(normalizeEntry)
      : [];
    render();
  });

  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
      scheduleRefresh();
    }
  });

  document.getElementById('entryList').addEventListener('click', handleListClick);
}

function scheduleRefresh() {
  clearTimeout(scheduleRefresh.timer);
  scheduleRefresh.timer = setTimeout(refreshActiveVideo, 250);
}

async function refreshActiveVideo() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return;
  }

  if (!tab?.id || !isYouTubeWatchUrl(tab.url)) {
    if (currentVideo) {
      currentVideo = null;
      render();
    }
    return;
  }

  const videoKey = getVideoKey(tab.url);
  if (!videoKey) return;

  let meta = null;
  try {
    const response = await sendMessageToTab(tab.id, { action: 'getVideoMetaV2' });
    meta = response?.ok ? response.data : null;
  } catch {
    meta = null;
  }

  const nextVideo = normalizeVideo({
    ...(meta || {}),
    title: meta?.title || cleanTabTitle(tab.title) || 'Untitled YouTube video',
    url: meta?.url || tab.url,
    videoId: meta?.videoId || videoKey,
    tabId: tab.id,
  });

  const previousKey = currentVideo?.videoKey || null;
  currentVideo = nextVideo;

  if (previousKey !== nextVideo.videoKey && !findEntry(nextVideo.videoKey)) {
    expandedId = draftId(nextVideo.videoKey);
  }

  render();
}

async function handleListClick(event) {
  const promptButton = event.target.closest('[data-action="run-prompt"]');
  if (promptButton) {
    event.preventDefault();
    await runPrompt(promptButton.dataset.videoKey, promptButton.dataset.prompt);
    return;
  }

  const deleteButton = event.target.closest('[data-action="delete"]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    await deleteEntry(deleteButton.dataset.videoKey);
    return;
  }

  if (event.target.closest('a, button')) return;

  const header = event.target.closest('[data-action="expand"]');
  if (header) {
    expandedId = expandedId === header.dataset.id ? null : header.dataset.id;
    render();
  }
}

async function runPrompt(videoKey, promptKey) {
  if (activeRun) return;

  const prompt = PROMPTS[promptKey];
  if (!prompt) return;

  if (!currentVideo || currentVideo.videoKey !== videoKey) {
    showToast('Open that video tab before running a prompt');
    return;
  }

  activeRun = { videoKey, promptKey };
  expandedId = findEntry(videoKey)?.id || draftId(videoKey);
  render();

  try {
    const response = await sendMessageToTab(currentVideo.tabId, {
      action: 'runGeminiPromptV2',
      prompt: prompt.prompt,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Gemini did not return a response');
    }

    const video = normalizeVideo({
      ...currentVideo,
      ...(response.data?.meta || {}),
      tabId: currentVideo.tabId,
    });

    const entry = upsertEntry(video);
    entry.responses[promptKey] = {
      promptKey,
      label: prompt.label,
      prompt: prompt.prompt,
      text: response.data.responseText,
      generatedAt: Date.now(),
    };
    entry.updatedAt = Date.now();

    await saveEntries();
    expandedId = entry.id;
    showToast(`${prompt.label} saved`);
  } catch (err) {
    showToast(err.message || 'Prompt failed');
    console.error('[YouTube Gemini Summariser] prompt failed:', err);
  } finally {
    activeRun = null;
    render();
  }
}

function upsertEntry(video) {
  let entry = findEntry(video.videoKey);

  if (!entry) {
    entry = {
      id: video.videoKey,
      videoKey: video.videoKey,
      title: video.title,
      channel: video.channel,
      url: video.url,
      canonicalUrl: video.canonicalUrl,
      thumbnail: video.thumbnail,
      favicon: video.favicon,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      responses: {},
    };
    entries.push(entry);
    return entry;
  }

  Object.assign(entry, {
    title: video.title || entry.title,
    channel: video.channel || entry.channel,
    url: video.url || entry.url,
    canonicalUrl: video.canonicalUrl || entry.canonicalUrl,
    thumbnail: video.thumbnail || entry.thumbnail,
    favicon: video.favicon || entry.favicon,
  });

  entry.responses = entry.responses || {};
  return entry;
}

async function deleteEntry(videoKey) {
  entries = entries.filter((entry) => entry.videoKey !== videoKey);
  if (expandedId === videoKey) expandedId = null;
  await saveEntries();
  render();
  showToast('Card removed');
}

function render() {
  const list = document.getElementById('entryList');
  const empty = document.getElementById('emptyState');
  const countWrap = document.getElementById('entryCount');
  const countNum = document.getElementById('entryCountNum');
  const countPlural = document.getElementById('entryCountPlural');

  const cards = buildCards();

  countNum.textContent = entries.length;
  countPlural.textContent = entries.length === 1 ? '' : 's';
  countWrap.style.display = entries.length ? 'flex' : 'none';

  if (!cards.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = cards.map((card) => buildCardHTML(card)).join('');
}

function buildCards() {
  const cards = entries.map((entry) => ({
    entry,
    isDraft: false,
    isActive: currentVideo?.videoKey === entry.videoKey,
  }));

  if (currentVideo && !findEntry(currentVideo.videoKey)) {
    cards.push({
      entry: {
        id: draftId(currentVideo.videoKey),
        videoKey: currentVideo.videoKey,
        title: currentVideo.title,
        channel: currentVideo.channel,
        url: currentVideo.url,
        canonicalUrl: currentVideo.canonicalUrl,
        thumbnail: currentVideo.thumbnail,
        favicon: currentVideo.favicon,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        responses: {},
      },
      isDraft: true,
      isActive: true,
    });
  }

  return cards;
}

function buildCardHTML(card) {
  const entry = card.entry;
  const id = card.isDraft ? draftId(entry.videoKey) : entry.id;
  const isExpanded = expandedId === id || (card.isDraft && expandedId === null);
  const responseKeys = PROMPT_ORDER.filter((key) => entry.responses?.[key]);
  const responseCount = responseKeys.length;
  const dateLabel = entry.updatedAt ? formatDate(entry.updatedAt) : 'Current video';
  const cardClasses = [
    'entry-card',
    isExpanded ? 'entry-card--expanded' : '',
    card.isDraft ? 'entry-card--draft' : '',
  ].filter(Boolean).join(' ');

  return `
    <li class="${cardClasses}" data-video-key="${esc(entry.videoKey)}">
      <div class="entry-header" data-action="expand" data-id="${esc(id)}" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="entry-favicon-wrap">
          <img class="entry-favicon" src="${esc(entry.favicon || youtubeFavicon())}" alt="" onerror="this.style.display='none'">
        </div>
        <div class="entry-meta">
          <a class="entry-title" href="${esc(entry.canonicalUrl || entry.url)}" target="_blank" title="${esc(entry.title)}">${esc(entry.title)}</a>
          <div class="entry-domain">${esc(entry.channel || 'YouTube')}</div>
        </div>
        <span class="entry-chevron" aria-hidden="true">${isExpanded ? '^' : 'v'}</span>
        ${card.isDraft ? '' : `
          <button class="entry-delete" data-action="delete" data-video-key="${esc(entry.videoKey)}" aria-label="Remove card" title="Remove">x</button>
        `}
      </div>

      ${isExpanded ? `
        <div class="entry-body">
          ${entry.thumbnail ? `
            <img class="entry-thumbnail" src="${esc(entry.thumbnail)}" alt="" onerror="this.style.display='none'">
          ` : ''}

          <div class="entry-pills">
            <span class="pill">${card.isDraft ? 'Current video' : esc(dateLabel)}</span>
            <span class="pill">${responseCount} saved response${responseCount === 1 ? '' : 's'}</span>
            ${card.isActive ? '<span class="pill pill--active">Active tab</span>' : ''}
          </div>

          ${card.isActive ? buildPromptButtons(entry.videoKey) : ''}

          <div class="response-list">
            ${responseKeys.length
              ? responseKeys.map((key) => buildResponseHTML(entry.responses[key])).join('')
              : '<p class="empty-inline">No summaries yet.</p>'}
          </div>
        </div>
      ` : ''}
    </li>
  `;
}

function buildPromptButtons(videoKey) {
  return `
    <div class="prompt-section">
      <p class="prompt-section__label">Gemini Prompts</p>
      <div class="prompt-grid">
        ${PROMPT_ORDER.map((key) => {
          const prompt = PROMPTS[key];
          const isLoading = activeRun?.videoKey === videoKey && activeRun?.promptKey === key;
          const disabled = activeRun ? 'disabled' : '';
          return `
            <button
              class="prompt-btn ${prompt.className} ${isLoading ? 'prompt-btn--loading' : ''}"
              data-action="run-prompt"
              data-video-key="${esc(videoKey)}"
              data-prompt="${esc(key)}"
              ${disabled}
            >
              <span class="prompt-icon">${esc(prompt.icon)}</span>
              <span>${isLoading ? 'Running...' : esc(prompt.label)}</span>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function buildResponseHTML(response) {
  return `
    <article class="response-card">
      <div class="response-header">
        <span class="response-title">${esc(response.label || PROMPTS[response.promptKey]?.label || 'Response')}</span>
        <span class="response-date">${esc(formatDate(response.generatedAt))}</span>
      </div>
      <pre class="response-text">${esc(response.text)}</pre>
    </article>
  `;
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function normalizeEntry(entry) {
  const video = normalizeVideo(entry || {});
  return {
    id: entry.id || video.videoKey,
    videoKey: video.videoKey,
    title: video.title,
    channel: video.channel,
    url: video.url,
    canonicalUrl: video.canonicalUrl,
    thumbnail: video.thumbnail,
    favicon: video.favicon,
    createdAt: Number(entry.createdAt) || Date.now(),
    updatedAt: Number(entry.updatedAt) || Number(entry.createdAt) || Date.now(),
    responses: entry.responses && typeof entry.responses === 'object' ? entry.responses : {},
  };
}

function normalizeVideo(video) {
  const sourceUrl = video.url || video.canonicalUrl || '';
  const videoKey = video.videoKey || video.videoId || getVideoKey(sourceUrl) || '';
  const canonicalUrl = videoKey ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoKey)}` : sourceUrl;

  return {
    videoKey,
    title: cleanText(video.title) || 'Untitled YouTube video',
    channel: cleanText(video.channel) || 'YouTube',
    url: sourceUrl || canonicalUrl,
    canonicalUrl,
    thumbnail: video.thumbnail || (videoKey ? `https://i.ytimg.com/vi/${videoKey}/hqdefault.jpg` : ''),
    favicon: video.favicon || youtubeFavicon(),
    tabId: video.tabId,
  };
}

function findEntry(videoKey) {
  return entries.find((entry) => entry.videoKey === videoKey) || null;
}

function isYouTubeWatchUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const isYouTubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
    return isYouTubeHost && parsed.pathname === '/watch' && parsed.searchParams.has('v');
  } catch {
    return false;
  }
}

function getVideoKey(url) {
  try {
    return new URL(url).searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function draftId(videoKey) {
  return `draft_${videoKey}`;
}

function cleanTabTitle(title) {
  return cleanText(String(title || '').replace(/\s+-\s+YouTube$/i, ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function youtubeFavicon() {
  return 'https://www.google.com/s2/favicons?domain=www.youtube.com&sz=32';
}

function showToast(message) {
  document.querySelectorAll('.toast').forEach((toast) => toast.remove());

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('toast--show'));
  });

  setTimeout(() => {
    toast.classList.remove('toast--show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3200);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
