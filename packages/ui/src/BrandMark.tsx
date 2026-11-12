import logoUrl from './assets/logo.svg';

/** The logo's own proportions (Figma "Logo", 113.985 × 77.2158). */
const LOGO_RATIO = 113.985 / 77.2158;

/**
 * The Studio Pulse mark (the Figma logo asset). `size` is its height; the width follows the logo's
 * proportions, drawn as is.
 */
export function BrandMark({ size = 24, title }: { size?: number; title?: string }) {
  const width = Math.round(size * LOGO_RATIO * 100) / 100;
  return (
    <span
      className="sp-brandmark"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ width, height: size }}
    >
      <img className="sp-brandmark__img" src={logoUrl} alt="" width={width} height={size} draggable={false} />
    </span>
  );
}
