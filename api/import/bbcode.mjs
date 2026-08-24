// Converts Gazelle wiki markup (BBCode-ish, plus `==heading==` style headings)
// into HTML for storage in wiki_articles.body_html. Best-effort: the tag
// vocabulary here was taken from surveying every file in whatcd-goodbye/wikis
// (`grep -ohE '\[/?[a-zA-Z*][a-zA-Z0-9]*(=[^]]*)?\]' *.txt | sort | uniq -c`).
// Anything not recognized is left as literal (already HTML-escaped) text,
// which is a safe fallback rather than a broken render.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const WIKI_ARTICLE_LINK = /https?:\/\/what\.cd\/wiki\.php\?action=article(?:&amp;|&)(?:nojump=1(?:&amp;|&))?id=(\d+)/i;
const WIKI_BROWSE_LINK = /https?:\/\/what\.cd\/wiki\.php\?action=browse[^"'\s\]]*/i;

function rewriteInternalLink(href) {
  const articleMatch = href.match(WIKI_ARTICLE_LINK);
  if (articleMatch) return `/wiki/${articleMatch[1]}`;
  if (WIKI_BROWSE_LINK.test(href)) return '/wiki';
  return href;
}

const STASH_TOKEN = /@@STASH(\d+)@@/g;

export function bbcodeToHtml(body) {
  if (!body) return '';
  let html = escapeHtml(body).replace(/\r\n/g, '\n');

  // Stash [plain]/[code]/[pre] contents verbatim (already escaped) before
  // any other tag -- including the heading regex below -- gets a chance to
  // transform their insides (code samples can legitimately contain "=="
  // that must not become a heading).
  const stash = [];
  const push = (rendered) => {
    stash.push(rendered);
    return '@@STASH' + (stash.length - 1) + '@@';
  };
  html = html
    .replace(/\[plain\]([\s\S]*?)\[\/plain\]/gi, (_, inner) => push('<pre class="wiki-plain">' + inner + '</pre>'))
    .replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (_, inner) => push('<pre class="wiki-code">' + inner + '</pre>'))
    .replace(/\[pre\]([\s\S]*?)\[\/pre\]/gi, (_, inner) => push('<pre>' + inner + '</pre>'));

  // Missing images: we don't have the actual asset files.
  html = html.replace(/&lt;IMAGE_LINK&gt;/g, '<span class="wiki-missing-image">[image not available]</span>');

  // Headings: ==h2==, ===h3===, ====h4==. Not line-anchored -- these
  // routinely appear nested inside [align=center]...[/align] on the same
  // line rather than alone on their own line.
  html = html.replace(/(={2,4})([^=\n]+?)\1/g, (_, eq, text) => {
    const level = Math.min(eq.length, 4);
    return '<h' + level + '>' + text.trim() + '</h' + level + '>';
  });

  // [*] list items -> group consecutive ones into <ul>.
  {
    const out = [];
    let inList = false;
    for (const line of html.split('\n')) {
      const m = line.match(/^\[\*\][ \t]?(.*)$/);
      if (m) {
        if (!inList) {
          out.push('<ul class="wiki-list">');
          inList = true;
        }
        out.push('<li>' + m[1] + '</li>');
      } else {
        if (inList) {
          out.push('</ul>');
          inList = false;
        }
        out.push(line);
      }
    }
    if (inList) out.push('</ul>');
    html = out.join('\n');
  }

  // [url=href]text[/url], [url]href[/url] (case-insensitive tag name).
  html = html.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, href, text) => {
    const resolved = rewriteInternalLink(href.trim());
    const external = resolved === href.trim() && /^https?:\/\//i.test(resolved);
    return '<a href="' + resolved + '"' + (external ? ' rel="noopener noreferrer"' : '') + '>' + text + '</a>';
  });
  html = html.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_, href) => {
    const resolved = rewriteInternalLink(href.trim());
    return '<a href="' + resolved + '">' + href.trim() + '</a>';
  });

  // Simple inline/style tags.
  html = html
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<strong>$1</strong>')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<em>$1</em>')
    .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>')
    .replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>')
    .replace(/\[color=(#?[0-9a-zA-Z]{3,7})\]([\s\S]*?)\[\/color\]/gi, '<span style="color:$1">$2</span>')
    .replace(/\[size=(\d{1,3})\]([\s\S]*?)\[\/size\]/gi, (_, n, text) => {
      const px = Math.max(8, Math.min(72, Number(n)));
      return '<span style="font-size:' + px + 'px">' + text + '</span>';
    })
    .replace(/\[align=(center|left|right|justify)\]([\s\S]*?)\[\/align\]/gi, '<div style="text-align:$1">$2</div>')
    .replace(/\[important\]([\s\S]*?)\[\/important\]/gi, '<div class="wiki-important">$1</div>')
    .replace(/\[quote=([^\]]+)\]([\s\S]*?)\[\/quote\]/gi, '<blockquote><cite>$1</cite>$2</blockquote>')
    .replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, '<blockquote>$1</blockquote>')
    .replace(/\[hide=([^\]]+)\]([\s\S]*?)\[\/hide\]/gi, '<details><summary>$1</summary>$2</details>')
    .replace(/\[hide\]([\s\S]*?)\[\/hide\]/gi, '<details><summary>Show</summary>$1</details>')
    .replace(/\[table\]/gi, '<table>')
    .replace(/\[\/table\]/gi, '</table>')
    .replace(/\[tr\]/gi, '<tr>')
    .replace(/\[\/tr\]/gi, '</tr>')
    .replace(/\[td\]/gi, '<td>')
    .replace(/\[\/td\]/gi, '</td>');

  // Restore stashed [plain]/[code]/[pre] blocks.
  html = html.replace(STASH_TOKEN, (_, i) => stash[Number(i)]);

  // Paragraphs: blank-line-separated blocks. Leave blocks that are already
  // block-level HTML alone; wrap plain text blocks in <p>, single \n -> <br>.
  const blockTag = /^<(h[1-4]|div|ul|blockquote|pre|table|details)[ >]/i;
  html = html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (blockTag.test(trimmed)) return trimmed;
      return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
    })
    .filter(Boolean)
    .join('\n');

  return html;
}
