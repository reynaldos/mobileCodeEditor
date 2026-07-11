import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

/*
 * shadcn/ui Dialog (https://ui.shadcn.com/docs/components/dialog), on Radix.
 * Classes re-pointed at this app's theme tokens; a fuller shadcn token adoption
 * is a later lift. Centered modal — the build modal and confirmations use it.
 */

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      className={cn('fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm', className)}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }): React.JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-[60] w-[min(440px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-panel p-5 shadow-2xl',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-md text-muted hover:bg-line"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('mb-4 flex flex-col gap-1 pr-6', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('mt-5 flex gap-2', className)} {...props} />
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element {
  return <DialogPrimitive.Title className={cn('text-[17px] font-semibold text-fg', className)} {...props} />
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>): React.JSX.Element {
  return <DialogPrimitive.Description className={cn('text-[13px] text-muted', className)} {...props} />
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
