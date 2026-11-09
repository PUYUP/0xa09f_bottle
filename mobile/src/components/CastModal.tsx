import { useEffect, useState } from "react";
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonTextarea,
  IonTitle,
  IonToolbar,
  IonModal,
  IonNote,
} from "@ionic/react";
import { send } from "ionicons/icons";

// Cast composer opened by the center FAB. The message is sealed client-side
// (AES-256-GCM) before it ever leaves the device.
export function CastModal({
  open,
  busy,
  onClose,
  onCast,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCast: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) setText("");
  }, [open]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onCast(t)
      .then(() => {
        setText("");
        onClose();
      })
      .catch(() => {});
  };

  return (
    <IonModal isOpen={open} onDidDismiss={onClose}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>cast into the sea</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onClose}>cancel</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonTextarea
          placeholder="write something for the sea…"
          value={text}
          autoGrow
          onIonInput={(e) => setText(e.detail.value ?? "")}
        />
        <IonNote>sealed with AES-256-GCM — nobody, not even the relay, reads it</IonNote>
        <IonButton
          expand="block"
          className="ion-margin-top"
          disabled={busy || !text.trim()}
          onClick={submit}
        >
          <IonIcon icon={send} slot="start" />
          cast it
        </IonButton>
      </IonContent>
    </IonModal>
  );
}
