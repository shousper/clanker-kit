# Tailwind CSS standards

## Version

- Target Tailwind CSS v4.1 or newer.
- Check the installed version in `package.json` before you use a v4.1 feature such as masks or text shadows.
- Never use `@apply`. Use CSS variables, the `--spacing()` function, or framework components instead.

## Removed utilities

Never use these in v4. Use the replacement.

| v3                      | v4                                                |
| ----------------------- | ------------------------------------------------- |
| `bg-opacity-*`          | Use opacity modifiers like `bg-black/50`          |
| `text-opacity-*`        | Use opacity modifiers like `text-black/50`        |
| `border-opacity-*`      | Use opacity modifiers like `border-black/50`      |
| `divide-opacity-*`      | Use opacity modifiers like `divide-black/50`      |
| `ring-opacity-*`        | Use opacity modifiers like `ring-black/50`        |
| `placeholder-opacity-*` | Use opacity modifiers like `placeholder-black/50` |
| `flex-shrink-*`         | `shrink-*`                                        |
| `flex-grow-*`           | `grow-*`                                          |
| `overflow-ellipsis`     | `text-ellipsis`                                   |
| `decoration-slice`      | `box-decoration-slice`                            |
| `decoration-clone`      | `box-decoration-clone`                            |

## Renamed utilities

Always use the v4 name.

| v3                 | v4                 |
| ------------------ | ------------------ |
| `bg-gradient-*`    | `bg-linear-*`      |
| `shadow-sm`        | `shadow-xs`        |
| `shadow`           | `shadow-sm`        |
| `drop-shadow-sm`   | `drop-shadow-xs`   |
| `drop-shadow`      | `drop-shadow-sm`   |
| `blur-sm`          | `blur-xs`          |
| `blur`             | `blur-sm`          |
| `backdrop-blur-sm` | `backdrop-blur-xs` |
| `backdrop-blur`    | `backdrop-blur-sm` |
| `rounded-sm`       | `rounded-xs`       |
| `rounded`          | `rounded-sm`       |
| `outline-none`     | `outline-hidden`   |
| `ring`             | `ring-3`           |

## Layout and spacing

- Use `gap-*` for spacing between children in flex and grid layouts. Never use `space-x-*` or `space-y-*` there.
- Use `min-h-dvh` instead of `min-h-screen`, which misbehaves on mobile Safari.
- Use `size-*` instead of separate `w-*` and `h-*` when the two values are equal.

## Typography

- Set the line height with a modifier on the text size, such as `text-base/7`.

## Gradients

Use `bg-radial` or `bg-radial-[<position>]` for radial gradients, and `bg-conic` or `bg-conic-*` for conic gradients.

## CSS variables and theme

Tailwind v4 exposes every theme value as a CSS variable. Models trained on v3 often reach for `theme()` or a JavaScript config instead.

- Read theme values with `var(--color-red-500)` or `var(--radius-lg)`.
- Compute spacing with `--spacing()`, not `theme(spacing.16)`.
- Extend the theme in CSS with `@theme`, not in `tailwind.config.js`.

```css
@import "tailwindcss";

@theme {
  --color-mint-500: oklch(0.72 0.11 178);
}

.panel {
  background: var(--color-mint-500);
  margin-top: calc(100vh - --spacing(16));
}
```

`@theme` generates matching utilities, so `bg-mint-500` works in markup.

## New in v4

- Container queries: mark the parent with `@container` and use `@md:` and `@lg:` variants on children.
- Container query units: use `cqw` and related units, for example `text-[50cqw]`.
- Text shadows (v4.1): use `text-shadow-2xs` to `text-shadow-lg`, with an opacity modifier such as `text-shadow-sm/50`.
- Masks (v4.1): use composable utilities such as `mask-t-from-50%` and `mask-radial-from-75%`.
