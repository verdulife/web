import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_SRC,
  MAX_IMAGE_TEXT,
  MAX_LABEL,
  MAX_SLUG,
  MAX_URL,
  MAX_WIDGETS,
  WIDGET_TYPE_ALLOWLIST,
  isSiteImagePath,
  normalizeWidgets,
} from "../src/widgets";

describe("normalizeWidgets", () => {
  it("passes plain text without any URLs through untouched", () => {
    const input = "Texto plano sin enlaces ni widgets.";
    expect(normalizeWidgets(input)).toEqual({ reply: input, widgets: [] });
  });

  describe("link tokens", () => {
    it("converts a valid link token without a label", () => {
      const result = normalizeWidgets('Hola [[widget:link url="https://example.com"]] adiós');
      expect(result.reply).toBe("Hola [[widget:0]] adiós");
      expect(result.widgets).toEqual([
        { index: 0, type: "link", url: "https://example.com" },
      ]);
    });

    it("converts a valid link token with a label", () => {
      const result = normalizeWidgets(
        '[[widget:link url="https://example.com" label="Opcional"]]',
      );
      expect(result.reply).toBe("[[widget:0]]");
      expect(result.widgets).toEqual([
        { index: 0, type: "link", url: "https://example.com", label: "Opcional" },
      ]);
    });

    it("truncates a label longer than the cap", () => {
      const label = "x".repeat(MAX_LABEL + 10);
      const result = normalizeWidgets(`[[widget:link url="https://example.com" label="${label}"]]`);
      expect(result.widgets[0].label).toBe("x".repeat(MAX_LABEL));
    });

    it("drops a link token missing its url", () => {
      const result = normalizeWidgets('[[widget:link label="Sin url"]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });
  });

  describe("project tokens", () => {
    it("converts a valid project token", () => {
      const result = normalizeWidgets('[[widget:project slug="botanic"]]');
      expect(result.reply).toBe("[[widget:0]]");
      expect(result.widgets).toEqual([{ index: 0, type: "project", slug: "botanic" }]);
    });

    it("drops a project token with invalid characters in the slug", () => {
      const result = normalizeWidgets('[[widget:project slug="Botanic!"]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops a project token missing its slug", () => {
      const result = normalizeWidgets("[[widget:project]]");
      expect(result).toEqual({ reply: "", widgets: [] });
    });
  });

  describe("projects tokens", () => {
    it("converts a bare projects token without any attributes", () => {
      const result = normalizeWidgets("Todos mis proyectos:\n\n[[widget:projects]]");
      expect(result.reply).toBe("Todos mis proyectos:\n\n[[widget:0]]");
      expect(result.widgets).toEqual([{ index: 0, type: "projects" }]);
    });

    it("keeps a projects token with extra attributes (ignored, not dropped)", () => {
      const result = normalizeWidgets('[[widget:projects limit="5" theme="dark"]]');
      expect(result.reply).toBe("[[widget:0]]");
      expect(result.widgets).toEqual([{ index: 0, type: "projects" }]);
    });

    it("matches only the exact 'projects' type name", () => {
      // The singular bare token is not a valid project token (slug required).
      expect(normalizeWidgets("[[widget:project]]")).toEqual({ reply: "", widgets: [] });
      // A close plural variant is an unknown type and gets dropped.
      expect(normalizeWidgets("[[widget:projectsx]]")).toEqual({ reply: "", widgets: [] });
      expect(normalizeWidgets("[[widget:proyectos]]")).toEqual({ reply: "", widgets: [] });
    });
  });

  describe("image tokens", () => {
    it("converts a valid image token with src and alt", () => {
      const result = normalizeWidgets(
        'Retrato [[widget:image src="/verdu.jpg" alt="Albert Verdu"]] aquí',
      );
      expect(result.reply).toBe("Retrato [[widget:0]] aquí");
      expect(result.widgets).toEqual([
        { index: 0, type: "image", src: "/verdu.jpg", alt: "Albert Verdu" },
      ]);
    });

    it("keeps an optional caption on a valid image token", () => {
      const result = normalizeWidgets(
        '[[widget:image src="/verdu.jpg" alt="Albert Verdu" caption="Opcional"]]',
      );
      expect(result.reply).toBe("[[widget:0]]");
      expect(result.widgets[0]).toEqual({
        index: 0,
        type: "image",
        src: "/verdu.jpg",
        alt: "Albert Verdu",
        caption: "Opcional",
      });
    });

    it("omits caption when absent and trims whitespace-only captions", () => {
      const noCaption = normalizeWidgets('[[widget:image src="/verdu.jpg" alt="Albert Verdu"]]');
      expect(noCaption.widgets[0]).not.toHaveProperty("caption");

      const blankCaption = normalizeWidgets(
        '[[widget:image src="/verdu.jpg" alt="Albert Verdu" caption="   "]]',
      );
      expect(blankCaption.widgets[0]).not.toHaveProperty("caption");
    });

    it("drops an image token missing its src", () => {
      const result = normalizeWidgets('[[widget:image alt="Albert Verdu"]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops an image token missing its alt", () => {
      const result = normalizeWidgets('[[widget:image src="/verdu.jpg"]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops an image token whose alt is blank after trimming", () => {
      const result = normalizeWidgets('[[widget:image src="/verdu.jpg" alt="   "]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("rejects absolute, protocol or non-site src values", () => {
      for (const bad of [
        '[[widget:image src="https://cdn.example.com/x.png" alt="a"]]',
        '[[widget:image src="//cdn.example.com/x.png" alt="a"]]',
        '[[widget:image src="verdu.jpg" alt="a"]]',
        '[[widget:image src="/a/../b.jpg" alt="a"]]',
        '[[widget:image src="/../b.jpg" alt="a"]]',
      ]) {
        expect(normalizeWidgets(bad)).toEqual({ reply: "", widgets: [] });
      }
    });

    it("rejects src values with spaces or disallowed characters", () => {
      for (const bad of [
        '[[widget:image src="/a b.jpg" alt="a"]]',
        '[[widget:image src="/a?b.jpg" alt="a"]]',
        '[[widget:image src="/a#b.jpg" alt="a"]]',
        '[[widget:image src="/a\\b.jpg" alt="a"]]',
        '[[widget:image src="/a%20b.jpg" alt="a"]]',
      ]) {
        expect(normalizeWidgets(bad)).toEqual({ reply: "", widgets: [] });
      }
    });

    it("allows dot segments that are not exactly '..'", () => {
      const ok = normalizeWidgets('[[widget:image src="/assets/img/..foo.jpg" alt="a"]]');
      expect(ok.widgets).toEqual([
        { index: 0, type: "image", src: "/assets/img/..foo.jpg", alt: "a" },
      ]);
    });

    it("drops a src longer than the cap", () => {
      const src = `/${"a".repeat(MAX_IMAGE_SRC)}.jpg`;
      const result = normalizeWidgets(`[[widget:image src="${src}" alt="a"]]`);
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops an alt longer than the cap (required content, no silent truncation)", () => {
      const alt = "x".repeat(MAX_IMAGE_TEXT + 1);
      const result = normalizeWidgets(`[[widget:image src="/verdu.jpg" alt="${alt}"]]`);
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("truncates a caption longer than the cap to MAX_IMAGE_TEXT", () => {
      const caption = "y".repeat(MAX_IMAGE_TEXT + 10);
      const result = normalizeWidgets(
        `[[widget:image src="/verdu.jpg" alt="Albert Verdu" caption="${caption}"]]`,
      );
      expect(result.widgets[0].caption).toBe("y".repeat(MAX_IMAGE_TEXT));
    });

    it("preserves order and indexes when a link token precedes an image token", () => {
      const result = normalizeWidgets(
        '[[widget:link url="https://example.com"]] y [[widget:image src="/verdu.jpg" alt="Albert Verdu"]]',
      );
      expect(result.reply).toBe("[[widget:0]] y [[widget:1]]");
      expect(result.widgets).toEqual([
        { index: 0, type: "link", url: "https://example.com" },
        { index: 1, type: "image", src: "/verdu.jpg", alt: "Albert Verdu" },
      ]);
    });

    it("preserves order and indexes when an image token precedes a link token", () => {
      const result = normalizeWidgets(
        '[[widget:image src="/verdu.jpg" alt="Albert Verdu"]] y [[widget:link url="https://example.com"]]',
      );
      expect(result.reply).toBe("[[widget:0]] y [[widget:1]]");
      expect(result.widgets).toEqual([
        { index: 0, type: "image", src: "/verdu.jpg", alt: "Albert Verdu" },
        { index: 1, type: "link", url: "https://example.com" },
      ]);
    });
  });

  describe("invalid and malformed tokens", () => {
    it("drops a token with an unknown type", () => {
      const result = normalizeWidgets('[[widget:chart url="https://example.com/pic.png"]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops a token with an empty type", () => {
      const result = normalizeWidgets('[[widget: url="https://example.com"]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops a token missing its closing brackets", () => {
      const result = normalizeWidgets('[[widget:link url="https://example.com"');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops a token with junk inside", () => {
      const result = normalizeWidgets('[[widget:link url="https://example.com" foo]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("drops a token whose url attribute is malformed", () => {
      const result = normalizeWidgets('[[widget:link url=https://example.com]]');
      expect(result).toEqual({ reply: "", widgets: [] });
    });

    it("rejects javascript: and file: scheme urls", () => {
      const js = normalizeWidgets('[[widget:link url="javascript:alert(1)"]]');
      expect(js).toEqual({ reply: "", widgets: [] });

      const file = normalizeWidgets('[[widget:link url="file:///etc/passwd"]]');
      expect(file).toEqual({ reply: "", widgets: [] });
    });
  });

  describe("bare URLs", () => {
    it("converts a bare URL to a link widget", () => {
      const result = normalizeWidgets("Mira https://example.com aquí");
      expect(result.reply).toBe("Mira [[widget:0]] aquí");
      expect(result.widgets).toEqual([
        { index: 0, type: "link", url: "https://example.com" },
      ]);
    });

    it("strips trailing punctuation from a bare URL and keeps it as text", () => {
      const result = normalizeWidgets("visita https://x.com.");
      expect(result.reply).toBe("visita [[widget:0]].");
      expect(result.widgets[0].url).toBe("https://x.com");
    });

    it("strips repeated trailing punctuation clusters", () => {
      const result = normalizeWidgets("ver https://x.com).");
      expect(result.reply).toBe("ver [[widget:0]]).");
      expect(result.widgets[0].url).toBe("https://x.com");
    });

    it("leaves a non-fetchable bare URL as plain text", () => {
      const input = "mira file:///etc/passwd ahí";
      expect(normalizeWidgets(input)).toEqual({ reply: input, widgets: [] });
    });

    it("does not convert a bare URL longer than the cap", () => {
      const url = `https://example.com/${"a".repeat(MAX_URL)}`;
      const result = normalizeWidgets(`mira ${url} ahí`);
      expect(result.widgets).toEqual([]);
    });
  });

  describe("ordering", () => {
    it("numbers a token before a bare URL as 0 and 1 in that order", () => {
      const result = normalizeWidgets(
        '[[widget:link url="https://first.com"]] luego https://second.com',
      );
      expect(result.reply).toBe("[[widget:0]] luego [[widget:1]]");
      expect(result.widgets).toEqual([
        { index: 0, type: "link", url: "https://first.com" },
        { index: 1, type: "link", url: "https://second.com" },
      ]);
    });

    it("numbers a bare URL before a later token as 0 and 1", () => {
      const result = normalizeWidgets(
        'https://first.com luego [[widget:project slug="botanic"]]',
      );
      expect(result.reply).toBe("[[widget:0]] luego [[widget:1]]");
      expect(result.widgets).toEqual([
        { index: 0, type: "link", url: "https://first.com" },
        { index: 1, type: "project", slug: "botanic" },
      ]);
    });
  });

  describe("MAX_WIDGETS cap", () => {
    it("drops the widget beyond the cap while keeping surrounding text", () => {
      const urls = Array.from(
        { length: MAX_WIDGETS + 1 },
        (_, i) => `https://example.com/${i}`,
      );
      const input = urls.map((url, i) => `${url}${i < urls.length - 1 ? " " : ""}`).join("");
      const result = normalizeWidgets(input);

      expect(result.widgets).toHaveLength(MAX_WIDGETS);
      const expected = urls
        .slice(0, MAX_WIDGETS)
        .map((_, i) => `[[widget:${i}]]`)
        .join(" ");
      // The space before the dropped 5th URL remains as plain text.
      expect(result.reply.trim()).toBe(expected);
    });

    it("keeps placeholder count equal to widgets length", () => {
      const result = normalizeWidgets(
        "a https://one.com b https://two.com c https://three.com d https://four.com e https://five.com",
      );
      const placeholders = (result.reply.match(/\[\[widget:\d+\]\]/g) ?? []).length;
      expect(placeholders).toBe(result.widgets.length);
      expect(result.widgets).toHaveLength(MAX_WIDGETS);
    });
  });
});

describe("isSiteImagePath", () => {
  it("accepts a plain site-relative path", () => {
    expect(isSiteImagePath("/verdu.jpg")).toBe(true);
    expect(isSiteImagePath("/assets/img/retrato.png")).toBe(true);
    expect(isSiteImagePath("/a/b/c.jpg")).toBe(true);
  });

  it("accepts a segment starting with two dots as long as it is not exactly '..'", () => {
    expect(isSiteImagePath("/assets/..foo.jpg")).toBe(true);
  });

  it("rejects absolute, protocol-relative and non-rooted values", () => {
    expect(isSiteImagePath("https://example.com/x.png")).toBe(false);
    expect(isSiteImagePath("//cdn.example.com/x.png")).toBe(false);
    expect(isSiteImagePath("verdu.jpg")).toBe(false);
    expect(isSiteImagePath("")).toBe(false);
  });

  it("rejects traversal segments", () => {
    expect(isSiteImagePath("/../x.jpg")).toBe(false);
    expect(isSiteImagePath("/a/../b.jpg")).toBe(false);
  });

  it("rejects disallowed characters verbatim (no decoding)", () => {
    expect(isSiteImagePath("/a%20b.jpg")).toBe(false);
    expect(isSiteImagePath("/a?b.jpg")).toBe(false);
    expect(isSiteImagePath("/a#b.jpg")).toBe(false);
    expect(isSiteImagePath("/a b.jpg")).toBe(false);
    expect(isSiteImagePath("/a\\b.jpg")).toBe(false);
    expect(isSiteImagePath("/a:b.jpg")).toBe(false);
  });

  it("rejects a path longer than the cap", () => {
    expect(isSiteImagePath(`/${"a".repeat(MAX_IMAGE_SRC)}.jpg`)).toBe(false);
    expect(isSiteImagePath(`/${"a".repeat(MAX_IMAGE_SRC - 1)}`)).toBe(true);
  });
});

describe("exported constants", () => {
  it("exposes the widget type allowlist and limits", () => {
    expect(Array.from(WIDGET_TYPE_ALLOWLIST)).toEqual(["link", "project", "image", "projects"]);
    expect(MAX_WIDGETS).toBe(4);
    expect(MAX_URL).toBe(2000);
    expect(MAX_LABEL).toBe(120);
    expect(MAX_SLUG).toBe(64);
    expect(MAX_IMAGE_SRC).toBe(200);
    expect(MAX_IMAGE_TEXT).toBe(200);
  });
});

describe("slug length limit", () => {
  it("drops a project token whose slug exceeds the cap", () => {
    const result = normalizeWidgets(`[[widget:project slug="${"a".repeat(MAX_SLUG + 1)}"]]`);
    expect(result).toEqual({ reply: "", widgets: [] });
  });
});