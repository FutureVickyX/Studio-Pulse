/** The Studio Pulse mark: a coral pulse line on a near-black tile (same geometry as the app icon). */
export function BrandMark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className="sp-brandmark"
    >
      <rect x="32" y="32" width="960" height="960" rx="224" fill="#16161c" />
      <rect
        x="32.5"
        y="32.5"
        width="959"
        height="959"
        rx="223.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.12"
        strokeWidth="16"
      />
      <polyline
        points="196,540 372,540 446,356 548,708 628,300 690,540 828,540"
        fill="none"
        stroke="#ff6b3d"
        strokeWidth="84"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
