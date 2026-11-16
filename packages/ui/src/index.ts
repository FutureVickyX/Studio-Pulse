/**
 * @studio-pulse/ui — design tokens, React primitives and lightweight SVG charts.
 * Import `@studio-pulse/ui/styles.css` once at the app root.
 */

export { cx } from './cx';
export { BrandMark } from './BrandMark';
export { Button, IconButton, Spinner } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from './Button';
export { Checkbox, Field, SegmentedControl, Select, Switch, TextInput } from './controls';
export type {
  CheckboxProps,
  FieldProps,
  SegmentedControlProps,
  SegmentedOption,
  SelectOption,
  SelectProps,
  SwitchProps,
  TextInputProps,
} from './controls';
export { Badge, Banner, Card, Disclosure, EmptyState, Kbd, Skeleton, SkeletonLines, StatusDot } from './layout';
export type { BadgeTone, BannerProps, BannerTone, CardProps, StatusTone } from './layout';
export { Dialog, Menu, Tooltip, placeFloating } from './overlay';
export type { AnchorRect, DialogProps, MenuItem, MenuProps, MenuTriggerProps, Placement, TooltipProps } from './overlay';
export { AreaChart, BarList, ChartTooltip, ColumnChart, Legend, StatGrid, StatTile, Swatch, TimelineStrip } from './charts';
export type {
  AreaChartProps,
  AreaDatum,
  BarListProps,
  BarListRow,
  BarListSegment,
  ChartTooltipContent,
  ChartTooltipRow,
  ColumnChartProps,
  ColumnDatum,
  ColumnSegment,
  LegendItem,
  MarkVariant,
  StatTileProps,
  TimelineItem,
  TimelineStripProps,
  TimelineTick,
  TooltipAnchor,
} from './charts';
export { durationTicks, formatAxisDuration, timelineTicks, timelineWindow } from './scales';
export { assignApplicationColors, colorFor, OTHER_COLOR, SERIES_COLORS, SERIES_SLOT_COUNT, TOTAL_COLOR } from './seriesColors';
export type { ColorCandidate } from './seriesColors';
export * from './icons';
