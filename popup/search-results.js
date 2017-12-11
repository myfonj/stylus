/* global tabURL handleEvent */
'use strict';

window.addEventListener('showStyles:done', function _() {
  window.removeEventListener('showStyles:done', _);

  if (!tabURL) {
    return;
  }

  //region Init

  const BODY_CLASS = 'search-results-shown';
  const RESULT_ID_PREFIX = 'search-result-';

  const BASE_URL = 'https://userstyles.org';
  const UPDATE_URL = 'https://update.userstyles.org/%.md5';

  const UI_LANG = chrome.i18n.getUILanguage();

  // normal category is just one word like 'github' or 'google'
  // but for some sites we need a fallback
  //   key: category.tld
  //   value <string>: use as category
  //   value true: fallback to search_terms
  const CATEGORY_FALLBACK = {
    'userstyles.org': 'userstyles.org',
    'last.fm': true,
    'Stylus': true,
  };
  const RX_CATEGORY = /^(?:.*?)([^.]+)(?:\.com?)?\.(\w+)$/;

  const DISPLAY_PER_PAGE = 10;
  // Millisecs to wait before fetching next batch of search results.
  const DELAY_AFTER_FETCHING_STYLES = 0;
  // Millisecs to wait before fetching .JSON for next search result.
  const DELAY_BEFORE_SEARCHING_STYLES = 0;

  const BLANK_PIXEL_DATA = 'data:image/gif;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAA' +
                           'C1HAwCAAAAC0lEQVR42mOcXQ8AAbsBHLLDr5MAAAAASUVORK5CYII=';

  const CACHE_SIZE = 1e6;
  const CACHE_PREFIX = 'usoSearchCache/';
  const CACHE_DURATION = 24 * 3600e3;
  const CACHE_CLEANUP_THROTTLE = 60e3;
  const CACHE_EXCEPT_PROPS = ['css', 'discussions', 'additional_info'];

  let searchTotalPages;
  let searchCurrentPage = 1;
  let searchExhausted = false;

  const processedResults = [];
  const unprocessedResults = [];

  let loading = false;
  // Category for the active tab's URL.
  let category;
  let scrollToFirstResult = true;

  let displayedPage = 1;
  let totalPages = 1;
  let totalResults = 0;

  // fade-in when the entry took that long to replace its placeholder
  const FADEIN_THRESHOLD = 50;

  const dom = {};

  Object.assign($('#find-styles-link'), {
    href: getSearchPageURL(tabURL),
    onclick(event) {
      if (!prefs.get('popup.findStylesInline') || dom.container) {
        handleEvent.openURLandHide.call(this, event);
        return;
      }
      event.preventDefault();

      this.textContent = this.title;
      this.title = '';

      init();
      load();
    },
  });

  return;

  function init() {
    setTimeout(() => document.body.classList.add(BODY_CLASS));

    $('#find-styles-inline-group').classList.add('hidden');

    dom.container = $('#search-results');
    dom.error = $('#search-results-error');

    dom.nav = {};
    const navOnClick = {prev, next};
    for (const place of ['top', 'bottom']) {
      const nav = $(`.search-results-nav[data-type="${place}"]`);
      nav.appendChild(template.searchNav.cloneNode(true));
      dom.nav[place] = nav;
      for (const child of $$('[data-type]', nav)) {
        const type = child.dataset.type;
        child.onclick = navOnClick[type];
        nav['_' + type] = child;
      }
    }

    dom.list = $('#search-results-list');

    addEventListener('styleDeleted', ({detail}) => {
      const entries = [...dom.list.children];
      const entry = entries.find(el => el._result.installedStyleId === detail.id);
      if (entry) {
        entry._result.installed = false;
        renderActionButtons(entry);
      }
    });

    addEventListener('styleAdded', ({detail: {style: {id, md5Url}}}) => {
      const usoId = md5Url && md5Url.match(/\d+|$/)[0];
      const entry = usoId && $('#' + RESULT_ID_PREFIX + usoId);
      if (entry) {
        entry._result.installed = true;
        entry._result.installedStyleId = id;
        renderActionButtons(entry);
      }
    });
  }

  //endregion
  //region Loader

  /**
   * Sets loading status of search results.
   * @param {Boolean} isLoading If search results are idle (false) or still loading (true).
   */
  function setLoading(isLoading) {
    if (loading !== isLoading) {
      loading = isLoading;
      // Refresh elements that depend on `loading` state.
      render();
    }
  }

  function showSpinner(parent) {
    parent = parent instanceof Node ? parent : $(parent);
    parent.appendChild($create('.lds-spinner',
      new Array(12).fill($create('div')).map(e => e.cloneNode())));
  }

  /** Increments displayedPage and loads results. */
  function next() {
    if (loading) {
      debounce(next, 100);
      return;
    }
    displayedPage += 1;
    scrollToFirstResult = true;
    render();
    loadMoreIfNeeded();
  }

  /** Decrements currentPage and loads results. */
  function prev() {
    if (loading) {
      debounce(next, 100);
      return;
    }
    displayedPage = Math.max(1, displayedPage - 1);
    scrollToFirstResult = true;
    render();
  }

  /**
   * Display error message to user.
   * @param {string} message  Message to display to user.
   */
  function error(reason) {
    dom.error.textContent =
      reason === 404 ?
        t('searchResultNoneFound') :
        t('genericErrorOccurred') + '\n' + reason;
    dom.error.classList.remove('hidden');
    dom.container.classList.toggle('hidden', !processedResults.length);
    document.body.classList.toggle('search-results-shown', processedResults.length > 0);
    if (dom.error.getBoundingClientRect().bottom > window.innerHeight) {
      dom.error.scrollIntoView();
    }
  }

  /**
   * Initializes search results container, starts fetching results.
   */
  function load() {
    if (searchExhausted) {
      if (!processedResults.length) {
        error(404);
      }
      return;
    }

    setLoading(true);
    dom.container.classList.remove('hidden');
    dom.error.classList.add('hidden');

    let pass = category ? 1 : 0;
    category = category || getCategory();

    search({category})
      .then(function process(results) {
        const data = results.data.filter(sameCategory);
        pass++;
        if (pass === 1 && !data.length) {
          category = getCategory({keepTLD: true});
          return search({category, restart: true}).then(process);
        }
        const numIrrelevant = results.data.length - data.length;
        totalResults = results.current_page === 1 ? results.total_entries : totalResults;
        totalResults = Math.max(0, totalResults - numIrrelevant);
        totalPages = Math.ceil(totalResults / DISPLAY_PER_PAGE);

        if (data.length) {
          setLoading(false);
          unprocessedResults.push(...data);
          processNextResult();
        } else if (numIrrelevant) {
          load();
        } else {
          return Promise.reject(404);
        }
      })
      .catch(error);
  }

  function loadMoreIfNeeded() {
    if (processedResults.length < (displayedPage + 1) * DISPLAY_PER_PAGE) {
      setTimeout(load, DELAY_BEFORE_SEARCHING_STYLES);
    }
  }

  /**
   * Processes the next search result in `unprocessedResults` and adds to `processedResults`.
   * Skips installed/non-applicable styles.
   * Fetches more search results if unprocessedResults is empty.
   * Recurses until shouldLoadMore() is false.
   */
  function processNextResult() {
    const result = unprocessedResults.shift();
    if (!result) {
      loadMoreIfNeeded();
      return;
    }
    const md5Url = UPDATE_URL.replace('%', result.id);
    getStylesSafe({md5Url}).then(([installedStyle]) => {
      if (installedStyle) {
        totalResults = Math.max(0, totalResults - 1);
      } else {
        processedResults.push(result);
        render();
      }
      setTimeout(processNextResult, !installedStyle && DELAY_AFTER_FETCHING_STYLES);
    });
  }

  //endregion
  //region UI

  function render() {
    let start = (displayedPage - 1) * DISPLAY_PER_PAGE;
    const end = displayedPage * DISPLAY_PER_PAGE;

    let plantAt = 0;
    let slot = dom.list.children[0];

    // keep rendered elements with ids in the range of interest
    while (
      plantAt < DISPLAY_PER_PAGE &&
      slot && slot.id === 'search-result-' + (processedResults[start] || {}).id
    ) {
      slot = slot.nextElementSibling;
      plantAt++;
      start++;
    }

    const plantEntry = entry => {
      if (slot) {
        dom.list.replaceChild(entry, slot);
        slot = entry.nextElementSibling;
      } else {
        dom.list.appendChild(entry);
      }
      entry.classList.toggle('search-result-fadein',
        !slot || performance.now() - slot._plantedTime > FADEIN_THRESHOLD);
      return entry;
    };

    while (start < Math.min(end, processedResults.length)) {
      plantEntry(createSearchResultNode(processedResults[start++]));
      plantAt++;
    }

    for (const place in dom.nav) {
      const nav = dom.nav[place];
      nav._prev.disabled = displayedPage <= 1;
      nav._next.disabled = displayedPage >= totalPages;
      nav._page.textContent = displayedPage;
      nav._total.textContent = totalPages;
    }

    // Fill in remaining search results with blank results + spinners
    const maxResults = end > totalResults &&
      totalResults % DISPLAY_PER_PAGE ||
      DISPLAY_PER_PAGE;
    while (plantAt < maxResults) {
      if (!slot || slot.id.startsWith(RESULT_ID_PREFIX)) {
        const entry = plantEntry(template.emptySearchResult.cloneNode(true));
        entry._plantedTime = performance.now();
        showSpinner(entry);
      }
      plantAt++;
      if (!processedResults.length) {
        break;
      }
    }

    while (dom.list.children.length > maxResults) {
      dom.list.lastElementChild.remove();
    }

    if (scrollToFirstResult &&
        dom.container.getBoundingClientRect().bottom > window.innerHeight * 2) {
      scrollToFirstResult = false;
      if (!FIREFOX || FIREFOX >= 55) {
        setTimeout(() => {
          dom.container.scrollIntoView({behavior: 'smooth', block: 'start'});
        });
      }
    }
  }

  /**
   * Constructs and adds the given search result to the popup's Search Results container.
   * @param {Object} result The SearchResult object from userstyles.org
   */
  function createSearchResultNode(result) {
    /*
      userstyleSearchResult format: {
        id: 100835,
        name: "Reddit Flat Dark",
        screenshot_url: "19339_after.png",
        description: "...",
        user: {
          id: 48470,
          name: "holloh"
        },
        style_settings: [...]
      }
    */

    const entry = template.searchResult.cloneNode(true);
    Object.assign(entry, {
      _result: result,
      id: RESULT_ID_PREFIX + result.id,
    });

    Object.assign($('.search-result-title', entry), {
      onclick: handleEvent.openURLandHide,
      href: BASE_URL + result.url
    });

    const displayedName = result.name.length < 300 ? result.name : result.name.slice(0, 300) + '...';
    $('.search-result-title span', entry).textContent = tWordBreak(displayedName);

    const screenshot = $('.search-result-screenshot', entry);
    let url = result.screenshot_url;
    if (!url) {
      url = BLANK_PIXEL_DATA;
      screenshot.classList.add('no-screenshot');
    } else if (/^[0-9]*_after.(jpe?g|png|gif)$/i.test(url)) {
      url = BASE_URL + '/style_screenshot_thumbnails/' + url;
    }
    screenshot.src = url;
    if (url !== BLANK_PIXEL_DATA) {
      screenshot.classList.add('search-result-fadein');
      screenshot.onload = () => {
        screenshot.classList.remove('search-result-fadein');
      };
    }

    const description = result.description
      .replace(/<[^>]*>/g, ' ')
      .replace(/([^.][.。?!]|[\s,].{50,70})\s+/g, '$1\n')
      .replace(/([\r\n]\s*){3,}/g, '\n\n');
    Object.assign($('.search-result-description', entry), {
      textContent: description,
      title: description,
    });

    Object.assign($('[data-type="author"] a', entry), {
      textContent: result.user.name,
      title: result.user.name,
      href: BASE_URL + '/users/' + result.user.id,
      onclick: handleEvent.openURLandHide,
    });

    let ratingClass;
    let ratingValue = result.rating;
    if (ratingValue === null) {
      ratingClass = 'none';
      ratingValue = '';
    } else if (ratingValue >= 2.5) {
      ratingClass = 'good';
      ratingValue = ratingValue.toFixed(1);
    } else if (ratingValue >= 1.5) {
      ratingClass = 'okay';
      ratingValue = ratingValue.toFixed(1);
    } else {
      ratingClass = 'bad';
      ratingValue = ratingValue.toFixed(1);
    }
    $('[data-type="rating"]', entry).dataset.class = ratingClass;
    $('[data-type="rating"] dd', entry).textContent = ratingValue;

    Object.assign($('[data-type="updated"] time', entry), {
      dateTime: result.updated,
      textContent: tryCatch(lang => {
        const date = new Date(result.updated);
        return date.toLocaleDateString(lang, {
          day: '2-digit',
          month: 'short',
          year: date.getYear() === new Date().getYear() ? undefined : '2-digit',
        });
      }, [UI_LANG, 'en']) || '',
    });


    $('[data-type="weekly"] dd', entry).textContent = formatNumber(result.weekly_install_count);
    $('[data-type="total"] dd', entry).textContent = formatNumber(result.total_install_count);

    renderActionButtons(entry);
    return entry;
  }

  function formatNumber(num) {
    return (
      num > 1e9 ? (num / 1e9).toFixed(1) + 'B' :
      num > 10e6 ? (num / 1e6).toFixed(0) + 'M' :
      num > 1e6 ? (num / 1e6).toFixed(1) + 'M' :
      num > 10e3 ? (num / 1e3).toFixed(0) + 'k' :
      num > 1e3 ? (num / 1e3).toFixed(1) + 'k' :
      num
    );
  }

  function renderActionButtons(entry) {
    const result = entry._result;

    if (result.installed && !('installed' in entry.dataset)) {
      entry.dataset.installed = '';
      $('.search-result-status', entry).textContent = t('installButtonInstalled');
    } else if (!result.installed && 'installed' in entry.dataset) {
      delete entry.dataset.installed;
      $('.search-result-status', entry).textContent = '';
    }

    const screenshot = $('.search-result-screenshot', entry);
    screenshot.onclick = result.installed ? onUninstallClicked : onInstallClicked;
    screenshot.title = result.installed ? t('deleteStyleLabel') : t('installButton');

    const uninstallButton = $('.search-result-uninstall', entry);
    uninstallButton.onclick = onUninstallClicked;

    const installButton = $('.search-result-install', entry);
    installButton.onclick = onInstallClicked;

    if ((result.style_settings || []).length > 0) {
      // Style has customizations
      installButton.classList.add('customize');
      uninstallButton.classList.add('customize');

      const customizeButton = $('.search-result-customize', entry);
      customizeButton.dataset.href = BASE_URL + result.url;
      customizeButton.dataset.sendMessage = JSON.stringify({method: 'openSettings'});
      customizeButton.classList.remove('hidden');
      customizeButton.onclick = function (event) {
        event.stopPropagation();
        handleEvent.openURLandHide.call(this, event);
      };
    }

    //installButton.classList.toggle('hidden', Boolean(result.installed));
    uninstallButton.classList.toggle('hidden', !result.installed);
  }

  function onUninstallClicked(event) {
    event.stopPropagation();
    const entry = this.closest('.search-result');
    deleteStyleSafe({id: entry._result.installedStyleId});
  }

  /** Installs the current userstyleSearchResult into Stylus. */
  function onInstallClicked(event) {
    event.stopPropagation();

    const entry = this.closest('.search-result');
    const result = entry._result;
    const installButton = $('.search-result-install', entry);

    showSpinner(entry);
    installButton.disabled = true;
    entry.style.setProperty('pointer-events', 'none', 'important');

    // Fetch settings to see if we should display "configure" button
    Promise.all([
      fetchStyleJson(result),
      fetchStyleSettings(result),
    ])
    .then(([style, settings]) => {
      // show a 'config-on-homepage' icon in the popup
      style.updateUrl += settings.length ? '?' : '';
      // show a 'style installed' tooltip in the manager
      style.reason = 'install';
      return saveStyleSafe(style);
    })
    .catch(reason => {
      const usoId = result.id;
      console.debug('install:saveStyleSafe(usoID:', usoId, ') => [ERROR]: ', reason);
      alert('Error while downloading usoID:' + usoId + '\nReason: ' + reason);
    })
    .then(() => {
      $.remove('.lds-spinner', entry);
      installButton.disabled = false;
      entry.style.pointerEvents = '';
    });

    function fetchStyleSettings(result) {
      return result.style_settings ||
        fetchStyle(result.id).then(style => {
          result.style_settings = style.style_settings || [];
          return result.style_settings;
        });
    }
  }

  //endregion
  //region USO API wrapper

  function getSearchPageURL() {
    const category = getCategory();
    return BASE_URL +
      '/styles/browse/' +
      (category in CATEGORY_FALLBACK ? '?search_terms=' : '') +
      category;
  }

  /**
   * Resolves the Userstyles.org "category" for a given URL.
   */
  function getCategory({keepTLD} = {}) {
    const u = tryCatch(() => new URL(tabURL));
    if (!u) {
      // Invalid URL
      return '';
    } else if (u.protocol === 'file:') {
      return 'file:';
    } else if (u.protocol === location.protocol) {
      return 'Stylus';
    } else {
      // Website address, strip TLD & subdomain
      const [, category = u.hostname, tld = ''] = u.hostname.match(RX_CATEGORY) || [];
      const categoryWithTLD = category + '.' + tld;
      const fallback = CATEGORY_FALLBACK[categoryWithTLD];
      return fallback === true && categoryWithTLD || fallback || category + (keepTLD ? tld : '');
    }
  }

  function sameCategory(result) {
    return result.subcategory && (
      category === result.subcategory ||
      category === 'Stylus' && /^(chrome|moz)-extension$/.test(result.subcategory) ||
      category.replace('.', '').toLowerCase() === result.subcategory.replace('.', '').toLowerCase()
    );
  }

  /**
   * Fetches the JSON style object from userstyles.org (containing code, sections, updateUrl, etc).
   * Stores (caches) the JSON within the given result, to avoid unnecessary network usage.
   * Style JSON is fetched from the /styles/chrome/{id}.json endpoint.
   * @param {Object} result A search result object from userstyles.org
   * @returns {Promise<Object>} Promises the response as a JSON object.
   */
  function fetchStyleJson(result) {
    return Promise.resolve(
      result.json ||
      download(BASE_URL + '/styles/chrome/' + result.id + '.json', {
        responseType: 'json',
      }).then(json => {
        result.json = json;
        return json;
      }));
  }

  /**
   * Fetches style information from userstyles.org's /api/v1/styles/{ID} API.
   * @param {number} userstylesId The internal "ID" for a style on userstyles.org
   * @returns {Promise<Object>} An object containing info about the style, e.g. name, author, etc.
   */
  function fetchStyle(userstylesId) {
    return readCache(userstylesId).then(json => json ||
      download(BASE_URL + '/api/v1/styles/' + userstylesId, {
        method: 'GET',
        headers: {
          'Content-type': 'application/json',
          'Accept': '*/*'
        },
        responseType: 'json',
        body: null
      }).then(json => {
        for (const prop of CACHE_EXCEPT_PROPS) {
          delete json[prop];
        }
        writeCache(json);
        return json;
      }));
  }

  /**
   * Fetches (and JSON-parses) search results from a userstyles.org search API.
   * Automatically sets searchCurrentPage and searchTotalPages.
   * @param {string} category The usrestyles.org "category" (subcategory) OR a any search string.
   * @return {Object} Response object from userstyles.org
   */
  function search({category, restart}) {
    if (restart) {
      searchCurrentPage = 1;
      searchTotalPages = undefined;
    }
    if (searchTotalPages !== undefined && searchCurrentPage > searchTotalPages) {
      return Promise.resolve({'data':[]});
    }

    const searchURL = BASE_URL +
      '/api/v1/styles/subcategory' +
      '?search=' + encodeURIComponent(category) +
      '&page=' + searchCurrentPage +
      '&country=NA';

    const cacheKey = category + '/' + searchCurrentPage;

    return readCache(cacheKey)
      .then(json => json ||
        download(searchURL, {
          method: 'GET',
          headers: {
            'Content-type': 'application/json',
            'Accept': '*/*'
          },
          responseType: 'json',
          body: null
        }).then(json => {
          json.id = cacheKey;
          writeCache(json);
          return json;
        }))
      .then(json => {
        searchCurrentPage = json.current_page + 1;
        searchTotalPages = json.total_pages;
        searchExhausted = (searchCurrentPage > searchTotalPages);
        return json;
      }).catch(reason => {
        searchExhausted = true;
        return Promise.reject(reason);
      });
  }

  //endregion
  //region Cache

  function readCache(id) {
    const key = CACHE_PREFIX + id;
    return BG.chromeLocal.getValue(key).then(item => {
      if (!cacheItemExpired(item)) {
        return tryJSONparse(BG.LZString.decompressFromUTF16(item.payload));
      } else if (item) {
        chrome.storage.local.remove(key);
      }
    });
  }

  function writeCache(data, debounced) {
    if (!debounced) {
      debounce(writeCache, 100, data, true);
      return data;
    } else {
      debounce(cleanupCache, CACHE_CLEANUP_THROTTLE);
      return BG.chromeLocal.setValue(CACHE_PREFIX + data.id, {
        payload: BG.LZString.compressToUTF16(JSON.stringify(data)),
        date: Date.now(),
      }).then(() => data);
    }
  }

  function cacheItemExpired(item) {
    return !item || !item.date || Date.now() - item.date > CACHE_DURATION;
  }

  function cleanupCache() {
    if (!chrome.storage.local.getBytesInUse) {
      chrome.storage.local.get(null, cleanupCacheInternal);
    } else {
      chrome.storage.local.getBytesInUse(null, size => {
        if (size > CACHE_SIZE) {
          chrome.storage.local.get(null, cleanupCacheInternal);
        }
        ignoreChromeError();
      });
    }
  }

  function cleanupCacheInternal(storage) {
    const sortedByTime = Object.keys(storage)
      .filter(key => key.startsWith(CACHE_PREFIX))
      .map(key => Object.assign(storage[key], {key}))
      .sort((a, b) => a.date - b.date);
    const someExpired = cacheItemExpired(sortedByTime[0]);
    const expired = someExpired ? sortedByTime.filter(cacheItemExpired) :
      sortedByTime.slice(0, sortedByTime.length / 2);
    const toRemove = expired.length ? expired : sortedByTime;
    if (toRemove.length) {
      chrome.storage.local.remove(toRemove.map(item => item.key), ignoreChromeError);
    }
    ignoreChromeError();
  }

  //endregion
});
