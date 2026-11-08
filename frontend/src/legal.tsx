export function TermsContent() {
  return (
    <>
      <h2>Terms of Service</h2>
      <p>
        a09f is an anonymous, end-to-end encrypted "message in a bottle" relay.
        By using it you agree to these terms.
      </p>

      <h3>1. The service</h3>
      <p>
        You can cast encrypted messages ("casts") into a shared pool and catch
        messages addressed to keys you control. All message content is encrypted
        on your device with AES-256-GCM; the server never sees plaintext or
        private keys.
      </p>

      <h3>2. Acceptable use</h3>
      <p>You agree not to use a09f to:</p>
      <ul>
        <li>send illegal content, harassment, hate speech, or CSAM;</li>
        <li>attempt to break, probe, or overload the relay;</li>
        <li>impersonate others or circumvent blocks;</li>
        <li>scrape or bulk-harvest messages at scale.</li>
      </ul>
      <p>
        We provide block and report tools. Repeated abuse may lead to IP-level
        rate limiting or bans.
      </p>

      <h3>3. No guarantee of delivery</h3>
      <p>
        Casts are ephemeral: pool keys expire, bottles time out, and a cast may
        simply never be caught. We do not guarantee delivery, uptime, or
        persistence of any message.
      </p>

      <h3>4. Your keys, your responsibility</h3>
      <p>
        Private keys live only on your device. If you lose them — or clear
        app data without exporting your vault — your messages become
        permanently unreadable. We cannot recover them.
      </p>

      <h3>5. Disclaimer</h3>
      <p>
        The service is provided "as is" without warranties of any kind. To the
        maximum extent permitted by law, we are not liable for lost messages,
        intercepted keys, or damages arising from use of the service.
      </p>

      <h3>6. Changes</h3>
      <p>
        These terms may be updated. Continued use after changes constitutes
        acceptance.
      </p>
    </>
  );
}

export function PrivacyContent() {
  return (
    <>
      <h2>Privacy Policy</h2>
      <p>
        a09f is designed so the server is <strong>blind</strong>: it stores
        ciphertext and public keys, never plaintext or private keys.
      </p>

      <h3>What stays on your device</h3>
      <ul>
        <li>Message plaintext — encrypted before it leaves your device.</li>
        <li>Private keys (identity, pool, reply) — stored in on-device storage
          (IndexedDB). They are never transmitted.</li>
        <li>Your vault export — an encrypted backup you choose to create.</li>
      </ul>

      <h3>What the server sees</h3>
      <ul>
        <li><strong>Ciphertext and wrapped keys</strong> — unreadable without
          the recipient's private key.</li>
        <li><strong>Public keys</strong> you deposit into the pool, plus an
          optional self-declared UTC offset used to prefer nearby timezones.</li>
        <li><strong>Metadata</strong>: timestamps, message/thread structure
          (who replied to what — as opaque IDs), sizes, delivery/claim state.</li>
        <li><strong>IP address</strong>, used transiently for rate limiting and
          abuse prevention. We do not build advertising profiles from it.</li>
      </ul>
      <p>
        Because bottle structure is public metadata, an observer can see that a
        conversation exists and its shape — but not what it says.
      </p>

      <h3>Your IP address</h3>
      <p>
        Your IP address <strong>is still recorded by the server</strong> — it is
        used transiently for rate limiting and abuse prevention, and may appear
        in standard server logs. a09f cannot hide your IP from the relay
        operator; only you can.
      </p>
      <p>
        If you want to be untracked, browse through an anonymity tool:
      </p>
      <ul>
        <li>
          <a href="https://www.torproject.org/" target="_blank" rel="noopener noreferrer">
            Tor Browser
          </a>{" "}
          — free, routes traffic through three relays so the server only sees a
          Tor exit node.
        </li>
        <li>
          A reputable VPN or proxy also masks your IP, though it shifts trust
          to the VPN provider.
        </li>
      </ul>
      <p>
        Note: Tor does not make you unidentifiable inside the app — your keys,
        messages and timing patterns are still yours. It only hides your IP
        from the server.
      </p>

      <h3>Accounts & identity</h3>
      <p>
        Registration is optional. A username only enables block/report
        features; it is not linked to your keys or messages cryptographically.
      </p>

      <h3>Reports & blocks</h3>
      <p>
        Reports store the reported bottle ID, optional reason, and — if you are
        signed in — your user ID for moderation. Blocks prevent your keys from
        being selected as recipients for that user's casts.
      </p>

      <h3>Data retention</h3>
      <ul>
        <li>Pool keys expire after their TTL and are removed automatically.</li>
        <li>Active bottles expire; delivered bottles are archived encrypted.</li>
        <li>We do not sell or share your data with third parties.</li>
      </ul>

      <h3>Your controls</h3>
      <p>
        Export your vault to back up keys, delete app data to wipe everything
        locally, and use a different device identity at any time — there is no
        central account tying your activity together.
      </p>
    </>
  );
}
