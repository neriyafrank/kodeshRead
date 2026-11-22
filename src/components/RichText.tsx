/**
 * Renders the sanitized inline HTML stored in paragraphs.display_text
 * (<b> <strong> <i> <em> <u> <small> <big> <sup> <sub>) as nested <Text>, plus the
 * reader-only <mark> added around search hits (shared/search.js markTerms).
 */
import { memo, useMemo } from 'react';
import { Text, type TextProps, type TextStyle } from 'react-native';

const TAG_RE = /<(\/?)(b|strong|i|em|u|small|big|sup|sub|mark)>/g;

function styleFor(tag: string, baseSize: number, boldFamily?: string, markStyle?: TextStyle): TextStyle {
  switch (tag) {
    case 'mark':
      return markStyle ?? { backgroundColor: '#FFE58A' };
    case 'b':
    case 'strong':
      // Custom fonts need their bold face selected by family name (Android ignores fontWeight).
      return boldFamily ? { fontFamily: boldFamily } : { fontWeight: '700' };
    case 'i':
    case 'em':
      return { fontStyle: 'italic' };
    case 'u':
      return { textDecorationLine: 'underline' };
    case 'small':
      return { fontSize: baseSize * 0.82 };
    case 'big':
      return { fontSize: baseSize * 1.18 };
    case 'sup':
    case 'sub':
      return { fontSize: baseSize * 0.7 };
    default:
      return {};
  }
}

interface Segment {
  text: string;
  tags: string[];
}

export function parseInline(html: string): Segment[] {
  const out: Segment[] = [];
  const stack: string[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    if (m.index > last) out.push({ text: html.slice(last, m.index), tags: [...stack] });
    const [, close, tag] = m;
    if (close) {
      const i = stack.lastIndexOf(tag);
      if (i >= 0) stack.splice(i, 1);
    } else stack.push(tag);
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push({ text: html.slice(last), tags: [...stack] });
  return out.map((s) => ({ ...s, text: s.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }));
}

interface Props extends TextProps {
  html: string;
  fontSize: number;
  /** Family name of the bold face of the current font (for <b>/<strong>). */
  boldFamily?: string;
  /** Style of <mark> (search hits flashed after a jump). */
  markStyle?: TextStyle;
}

export const RichText = memo(function RichText({ html, fontSize, boldFamily, markStyle, style, ...rest }: Props) {
  const segments = useMemo(() => parseInline(html), [html]);
  return (
    <Text style={[{ fontSize }, style]} {...rest}>
      {segments.map((s, i) =>
        s.tags.length ? (
          <Text key={i} style={s.tags.map((t) => styleFor(t, fontSize, boldFamily, markStyle))}>
            {s.text}
          </Text>
        ) : (
          s.text
        ),
      )}
    </Text>
  );
});
