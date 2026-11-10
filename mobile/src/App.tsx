import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IonApp,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonIcon,
  IonModal,
  IonTabBar,
  IonTabButton,
  IonTabs,
  IonTab,
  IonBadge,
  IonFab,
  IonFabButton,
  IonPage,
  IonRouterOutlet,
} from "@ionic/react";
import {
  send,
  refresh,
  helpCircle,
  cloudDownload,
  chatboxOutline,
  fishOutline,
  personOutline,
} from "ionicons/icons";
import { Route, useHistory } from "react-router-dom";
import { IonReactRouter } from "@ionic/react-router";
import { getState, subscribe } from "@shared/store";
import {
  init,
  dropBottle,
  checkBottles,
  generateAndDeposit,
  log,
  claimUsernameUI,
  importVaultFile,
} from "@shared/store";
import { getIdentity, randomUsername as genName } from "@shared/identity";
import { hasUnreadReplies } from "./lib/unread";
import { TermsContent, PrivacyContent, HowItWorksContent } from "./legal";
import { CatchPage } from "./screens/CatchPage";
import { BaitPage } from "./screens/BaitPage";
import { AccountPage } from "./screens/AccountPage";
import { CastModal } from "./components/CastModal";
import { ChatScreen } from "./screens/ChatScreen";
import type { IdentityRecord } from "@shared/types";

export default function App() {
  const state = useSyncExternalStore(subscribe, getState);
  const [castOpen, setCastOpen] = useState(false);
  const [legal, setLegal] = useState<"terms" | "privacy" | "how" | null>(null);
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [claimName, setClaimName] = useState("");
  const [catchToast, setCatchToast] = useState(false);
  const autoBaited = useRef(false);
  const gateFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init().catch((e) => log(`boot: ${(e as Error).message}`, "err"));
    getIdentity().then((id) => {
      setIdentity(id);
      setClaimName((n) => n || genName());
    }).catch(() => {});
  }, []);

  // Onboarding: brand-new users get three starter baits cast automatically.
  useEffect(() => {
    if (autoBaited.current || !state.ready || state.keys.length > 0 || !identity?.username) return;
    autoBaited.current = true;
    (async () => {
      for (let i = 0; i < 3; i++) {
        await generateAndDeposit("86400").catch(() => {});
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ready, state.keys.length, identity?.username]);

  // New-catch toast: an SSE bottle event means something landed on our bait.
  useEffect(() => {
    if (!state.lastCatchAt) return;
    setCatchToast(true);
    const t = setTimeout(() => setCatchToast(false), 6000);
    return () => clearTimeout(t);
  }, [state.lastCatchAt]);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    return fn()
      .catch((e) => log((e as Error).message, "err"))
      .finally(() => setBusy(false));
  };

  const unread = state.records.filter(
    (r) => !r.bottle?.parentId && hasUnreadReplies(r, state.records)
  ).length;

  // Mandatory username gate — same policy as the web client.
  if (identity && !identity.username) {
    return (
      <IonApp>
        <IonContent className="ion-padding" style={{ display: "flex", alignItems: "center" }}>
          <div style={{ width: "100%" }}>
            <h2>choose your name</h2>
            <p style={{ color: "var(--ion-color-medium)", fontSize: 14 }}>
              a09f needs a username — bound to this device's identity key
              forever. A random one is prefilled; regenerate if you like.
            </p>
            <IonItem lines="none" className="ion-margin-top">
              <IonInput
                label="username"
                value={claimName}
                onIonInput={(e) => setClaimName(e.detail.value ?? "")}
              />
              <IonButton
                slot="end"
                fill="clear"
                onClick={() => setClaimName(genName())}
                title="random username"
              >
                <IonIcon icon={refresh} slot="icon-only" />
              </IonButton>
            </IonItem>
            <IonButton
              expand="block"
              className="ion-margin-top"
              disabled={busy || !claimName.trim()}
              onClick={() =>
                run(async () => {
                  await claimUsernameUI(claimName.trim());
                  setIdentity(await getIdentity());
                })
              }
            >
              claim &amp; enter
            </IonButton>
            <IonButton
              expand="block"
              fill="outline"
              size="small"
              className="ion-margin-top"
              onClick={() => setLegal("how")}
            >
              <IonIcon icon={helpCircle} slot="start" />
              how does this work?
            </IonButton>
            <div className="ion-margin-top" style={{ borderTop: "1px solid var(--ion-color-light)", paddingTop: 12 }}>
              <p style={{ color: "var(--ion-color-medium)", fontSize: 13 }}>
                coming back on a new device? your vault export holds the
                private keys that prove this identity — import it to restore
                your username, bait and message history.
              </p>
              <IonButton
                expand="block"
                fill="outline"
                size="small"
                onClick={() => gateFileRef.current?.click()}
              >
                <IonIcon icon={cloudDownload} slot="start" />
                import vault / secret file
              </IonButton>
              <input
                ref={gateFileRef}
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    await importVaultFile(f);
                    setIdentity(await getIdentity());
                  } catch (err) {
                    log(`import: ${(err as Error).message}`, "err");
                  }
                }}
              />
            </div>
          </div>
        </IonContent>
        <LegalModal kind={legal} onClose={() => setLegal(null)} />
      </IonApp>
    );
  }

  return (
    <IonApp>
      <IonReactRouter>
        <IonRouterOutlet>
          {/* standalone chat page — no tab bar, own IonFooter reply form */}
          <Route exact path="/bottles/:id" component={ChatScreen} />
          {/* everything else → the three tabs (exact: /bottles/:id is separate) */}
          <Route exact path="/">
            <IonPage>
              <IonTabs>
        <IonTab tab="catch">
          <CatchPage />
        </IonTab>

        <IonTab tab="bait">
          <BaitPage />
        </IonTab>

        <IonTab tab="account">
          <AccountPage identity={identity} onIdentity={setIdentity} onLegal={setLegal} />
        </IonTab>

        <IonTabBar slot="bottom">
          <IonTabButton tab="catch">
            <IonIcon icon={chatboxOutline} />
            <IonLabel>catch</IonLabel>
            {unread > 0 && (
              <IonBadge color="danger" slot="end">
                {unread > 99 ? "99+" : unread}
              </IonBadge>
            )}
          </IonTabButton>
          <IonTabButton tab="bait">
            <IonIcon icon={fishOutline} />
            <IonLabel>bait</IonLabel>
          </IonTabButton>
          <IonTabButton tab="account">
            <IonIcon icon={personOutline} />
            <IonLabel>account</IonLabel>
          </IonTabButton>
        </IonTabBar>

        {/* cast FAB — floats above the tab bar */}
        <IonFab
          vertical="bottom"
          horizontal="center"
          style={{ bottom: "calc(72px + env(safe-area-inset-bottom, 0px))" }}
        >
          <IonFabButton onClick={() => setCastOpen(true)} aria-label="cast a message">
            <IonIcon icon={send} />
          </IonFabButton>
        </IonFab>
              </IonTabs>
            </IonPage>
          </Route>
        </IonRouterOutlet>

        <CastModal
          open={castOpen}
          busy={busy}
          onClose={() => setCastOpen(false)}
          onCast={(text) =>
            run(async () => {
              await dropBottle(text, "86400");
            })
          }
        />

        {/* terms & privacy */}
        <LegalModal kind={legal} onClose={() => setLegal(null)} />

        <CatchToast
          show={catchToast}
          onPress={() => {
            setCatchToast(false);
            run(checkBottles);
          }}
        />
      </IonReactRouter>
    </IonApp>
  );
}

// New-catch toast — lives inside the router so it can navigate back to the
// catch tab even when the user is on a standalone /bottles/:id page.
function CatchToast({ show, onPress }: { show: boolean; onPress: () => void }) {
  const history = useHistory();
  if (!show) return null;
  return (
    <div
      onClick={() => {
        history.push("/");
        // after the tabs remount (or if already there), land on catch
        setTimeout(
          () =>
            (document.querySelector("ion-tabs") as HTMLIonTabsElement | null)?.select("catch"),
          60
        );
        onPress();
      }}
      style={{
        position: "fixed",
        bottom: "calc(150px + env(safe-area-inset-bottom, 0px))",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        background: "var(--ion-color-primary)",
        color: "#fff",
        padding: "10px 18px",
        borderRadius: 20,
        fontSize: 14,
        boxShadow: "0 4px 12px rgba(0,0,0,.3)",
        cursor: "pointer",
      }}
    >
      🎣 something bit! — tap to check catch
    </div>
  );
}

function LegalModal({
  kind,
  onClose,
}: {
  kind: "terms" | "privacy" | "how" | null;
  onClose: () => void;
}) {
  return (
    <IonModal isOpen={kind !== null} onDidDismiss={onClose}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>
            {kind === "terms" ? "terms of service" : kind === "privacy" ? "privacy policy" : "how it works"}
          </IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onClose}>close</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding" style={{ fontSize: 14, lineHeight: 1.5 }}>
        {kind === "terms" ? <TermsContent /> : kind === "privacy" ? <PrivacyContent /> : <HowItWorksContent />}
      </IonContent>
    </IonModal>
  );
}
