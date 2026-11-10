import { useRef, useState } from "react";
import {
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSpinner,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonContent,
} from "@ionic/react";
import {
  cloudDownload,
  cloudUpload,
  phonePortraitOutline,
  refresh,
  trash,
} from "ionicons/icons";
import {
  changeUsernameUI,
  deleteAccount,
  exportVault,
  fetchDevices,
  importVaultFile,
  log,
  revokeDevice,
} from "@shared/store";
import type { DeviceInfo } from "@shared/store";
import { getIdentity, randomUsername as genName } from "@shared/identity";
import type { IdentityRecord } from "@shared/types";

export function AccountPage({
  identity,
  onIdentity,
  onLegal,
}: {
  identity: IdentityRecord | null;
  onIdentity: (id: IdentityRecord | null) => void;
  onLegal: (kind: "terms" | "privacy" | "how") => void;
}) {
  const [username, setUsername] = useState("");
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const openDevices = () => {
    setDevices(null);
    setDevicesOpen(true);
    fetchDevices()
      .then(setDevices)
      .catch((e) => {
        log(`devices: ${(e as Error).message}`, "err");
        setDevices([]);
      });
  };

  return (
    <>
      <IonHeader>
        <IonToolbar color="primary">
          <IonTitle>account</IonTitle>
        </IonToolbar>
      </IonHeader>
      <div className="tab-scroll ion-padding">
      {/* identity */}
      <IonItem lines="full" className="ion-margin-top">
        <IonLabel>
          {identity?.username ? (
            <>
              signed in as <strong>@{identity.username}</strong>
              <p style={{ fontFamily: "monospace", fontSize: 12 }}>{identity.userId}</p>
            </>
          ) : (
            <i>anonymous — claim a username to enable blocking, reporting &amp; stats</i>
          )}
        </IonLabel>
      </IonItem>

      {identity?.username ? (
        <IonItem lines="none">
          <IonInput
            label="new username"
            labelPlacement="stacked"
            placeholder="once every 7 days"
            value={username}
            onIonInput={(e) => setUsername(e.detail.value ?? "")}
          />
          <IonButton
            slot="end"
            fill="clear"
            onClick={() => setUsername(genName())}
            title="random username"
          >
            <IonIcon icon={refresh} slot="icon-only" />
          </IonButton>
          <IonButton
            slot="end"
            onClick={() =>
              changeUsernameUI(username.trim())
                .then(() => getIdentity().then(onIdentity))
                .catch((e) => log(`rename: ${(e as Error).message}`, "err"))
            }
            disabled={!username.trim()}
          >
            rename
          </IonButton>
        </IonItem>
      ) : null}

      {/* actions */}
      <IonList inset className="ion-margin-top">
        {identity?.username && (
          <IonItem button onClick={openDevices}>
            <IonIcon icon={phonePortraitOutline} slot="start" color="primary" />
            <IonLabel>devices</IonLabel>
            <IonNote slot="end">manage</IonNote>
          </IonItem>
        )}
        <IonItem button onClick={() => fileRef.current?.click()}>
          <IonIcon icon={cloudUpload} slot="start" color="primary" />
          <IonLabel>import vault</IonLabel>
          <IonNote slot="end">restore keys</IonNote>
        </IonItem>
        <IonItem
          button
          onClick={() =>
            exportVault().catch((e) => log(`export: ${(e as Error).message}`, "err"))
          }
        >
          <IonIcon icon={cloudDownload} slot="start" color="primary" />
          <IonLabel>export vault</IonLabel>
          <IonNote slot="end">backup</IonNote>
        </IonItem>
        {identity?.username && (
          <IonItem
            button
            onClick={() => {
              if (!window.confirm(`delete @${identity.username} permanently? this erases your username, blocks, reports and sync data. messages already delivered to others stay readable by them.`)) return;
              if (!window.confirm("are you absolutely sure? this cannot be undone.")) return;
              deleteAccount().catch((e) => log(`delete account: ${(e as Error).message}`, "err"));
            }}
          >
            <IonIcon icon={trash} slot="start" color="danger" />
            <IonLabel color="danger">delete account</IonLabel>
          </IonItem>
        )}
      </IonList>
      {/* legal */}
      <IonList inset className="ion-margin-top">
        <IonItem lines="none" className="ion-text-center">
          <IonLabel style={{ fontSize: 13 }}>
            <span style={{ color: "var(--ion-color-primary)", cursor: "pointer" }} onClick={() => onLegal("how")}>
              how it works
            </span>
            {" · "}
            <span style={{ color: "var(--ion-color-primary)", cursor: "pointer" }} onClick={() => onLegal("terms")}>
              terms
            </span>
            {" · "}
            <span style={{ color: "var(--ion-color-primary)", cursor: "pointer" }} onClick={() => onLegal("privacy")}>
              privacy
            </span>
          </IonLabel>
        </IonItem>
        <IonItem lines="none" className="ion-text-center">
          <IonNote style={{ fontSize: 11 }}>
            your IP is visible to the relay — use Tor Browser for untracked browsing
          </IonNote>
        </IonItem>
      </IonList>

      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) importVaultFile(f).catch((err) => log(`import: ${(err as Error).message}`, "err"));
        }}
      />

      {/* devices modal */}
      <IonModal isOpen={devicesOpen} onDidDismiss={() => setDevicesOpen(false)}>
        <IonHeader>
          <IonToolbar>
            <IonTitle>devices</IonTitle>
            <IonButtons slot="end">
              <IonButton onClick={() => setDevicesOpen(false)}>close</IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">
          <IonNote>
            devices that have signed in with this identity. revoking cuts off that device within a
            minute — it keeps its keys but can no longer prove they are yours.
          </IonNote>
          <IonList inset>
            {devices === null && (
              <IonItem lines="none">
                <IonSpinner slot="start" />
                <IonLabel>loading…</IonLabel>
              </IonItem>
            )}
            {devices?.length === 0 && (
              <IonItem lines="none">
                <IonLabel>no devices registered yet</IonLabel>
              </IonItem>
            )}
            {devices?.map((d) => (
              <IonItem key={d.deviceId} lines="full">
                <IonLabel>
                  <h3 style={{ fontFamily: "monospace" }}>{d.deviceId.slice(0, 8)}…</h3>
                  <p>
                    {d.userAgent ? d.userAgent.slice(0, 48) : "unknown client"} · seen{" "}
                    {new Date(d.lastSeen * 1000).toLocaleString()}
                    {d.current && " · this device"}
                    {d.revoked && " · revoked"}
                  </p>
                </IonLabel>
                {!d.current && !d.revoked && (
                  <IonButton
                    slot="end"
                    size="small"
                    fill="outline"
                    color="danger"
                    onClick={() => {
                      if (!window.confirm(`revoke device ${d.deviceId.slice(0, 8)}…? it will lose access within a minute.`)) return;
                      revokeDevice(d.deviceId)
                        .then(() => fetchDevices().then(setDevices))
                        .catch((e) => log(`revoke: ${(e as Error).message}`, "err"));
                    }}
                  >
                    revoke
                  </IonButton>
                )}
              </IonItem>
            ))}
          </IonList>
        </IonContent>
      </IonModal>
      </div>
    </>
  );
}
