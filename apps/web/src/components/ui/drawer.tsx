import { Drawer as DrawerPrimitive } from 'vaul'
import { cn } from '../../lib/utils.ts'

/*
 * shadcn/ui Drawer (https://ui.shadcn.com/docs/components/drawer), built on Vaul.
 * The default classes are re-pointed at this app's theme tokens (bg-panel,
 * border-line, text-muted) rather than shadcn's CSS-variable palette — a fuller
 * shadcn adoption (the token layer) is a later lift.
 */

function Drawer(props: React.ComponentProps<typeof DrawerPrimitive.Root>): React.JSX.Element {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerTrigger(props: React.ComponentProps<typeof DrawerPrimitive.Trigger>): React.JSX.Element {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal(props: React.ComponentProps<typeof DrawerPrimitive.Portal>): React.JSX.Element {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose(props: React.ComponentProps<typeof DrawerPrimitive.Close>): React.JSX.Element {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>): React.JSX.Element {
  return (
    <DrawerPrimitive.Overlay data-slot="drawer-overlay" className={cn('fixed inset-0 z-50 bg-black/60', className)} {...props} />
  )
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>): React.JSX.Element {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mt-24 flex h-auto max-h-[88vh] min-h-[30vh] flex-col rounded-t-2xl border-t border-line bg-panel',
          className,
        )}
        {...props}
      >
        <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-line" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="drawer-header" className={cn('flex flex-col gap-1 p-4', className)} {...props} />
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="drawer-footer" className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>): React.JSX.Element {
  return <DrawerPrimitive.Title data-slot="drawer-title" className={cn('text-[17px] font-semibold text-fg', className)} {...props} />
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>): React.JSX.Element {
  return <DrawerPrimitive.Description data-slot="drawer-description" className={cn('text-[13px] text-muted', className)} {...props} />
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
}
