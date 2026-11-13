/**
 * The kubedeck mark: the app icon (src-tauri/icons/source/kubedeck.svg) without its tile,
 * in the theme's accent so it follows every theme.
 */
export default function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="232 196 560 632" aria-hidden="true">
      <polygon points="512,232 754.5,372 754.5,652 512,792 269.5,652 269.5,372" fill="none" stroke="currentColor" strokeWidth="52" strokeLinejoin="round" />
      <rect x="392" y="420" width="240" height="46" rx="23" fill="currentColor" />
      <rect x="392" y="489" width="170" height="46" rx="23" fill="var(--text)" opacity="0.75" />
      <rect x="392" y="558" width="205" height="46" rx="23" fill="var(--text)" opacity="0.4" />
    </svg>
  );
}
