import React from 'react';

export default function NetworkGraphic() {
  return (
    <div className="learn-network" aria-hidden="true">
      <div className="learn-network__pulse learn-network__pulse--one" />
      <div className="learn-network__pulse learn-network__pulse--two" />

      <svg
        className="learn-network__svg"
        viewBox="0 0 520 380"
        role="presentation"
        focusable="false"
      >
        <defs>
          <linearGradient id="learnNodeFill" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1e78ff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#58c7ff" stopOpacity="0.8" />
          </linearGradient>
          <linearGradient id="learnNodeFillSoft" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#b6f2ea" stopOpacity="0.85" />
          </linearGradient>
        </defs>

        <path className="learn-network__link" d="M118 98 C170 120, 198 146, 236 174" />
        <path className="learn-network__link" d="M408 88 C360 112, 324 142, 286 176" />
        <path className="learn-network__link" d="M92 272 C152 256, 196 234, 236 206" />
        <path className="learn-network__link" d="M418 286 C366 258, 322 232, 286 206" />
        <path className="learn-network__link learn-network__link--soft" d="M256 58 C254 102, 256 138, 260 160" />
        <path className="learn-network__link learn-network__link--soft" d="M256 320 C254 282, 256 246, 260 220" />

        <circle className="learn-network__core" cx="260" cy="190" r="96" />
        <ellipse className="learn-network__ring" cx="260" cy="190" rx="108" ry="42" />
        <ellipse className="learn-network__ring" cx="260" cy="190" rx="58" ry="96" />
        <path className="learn-network__ring learn-network__ring--tilt" d="M182 146 C226 122, 292 120, 340 152 C372 174, 376 214, 344 236 C294 270, 222 270, 180 234 C148 206, 150 166, 182 146 Z" />

        <path className="learn-network__continent" d="M214 160 C228 148, 248 146, 262 152 C272 156, 280 166, 274 174 C264 188, 230 188, 214 178 C206 172, 206 166, 214 160 Z" />
        <path className="learn-network__continent learn-network__continent--soft" d="M248 206 C260 198, 282 196, 296 204 C306 210, 306 222, 294 228 C282 236, 258 236, 246 228 C238 222, 238 212, 248 206 Z" />
        <path className="learn-network__continent learn-network__continent--small" d="M200 214 C208 208, 220 208, 228 212 C234 216, 234 224, 226 228 C216 232, 204 230, 198 224 C194 220, 194 214, 200 214 Z" />

        <circle className="learn-network__node" cx="118" cy="98" r="12" />
        <circle className="learn-network__node" cx="408" cy="88" r="12" />
        <circle className="learn-network__node learn-network__node--soft" cx="92" cy="272" r="12" />
        <circle className="learn-network__node" cx="418" cy="286" r="12" />
        <circle className="learn-network__node learn-network__node--soft" cx="256" cy="58" r="10" />
        <circle className="learn-network__node learn-network__node--soft" cx="256" cy="320" r="10" />
      </svg>

      <div className="learn-network__badge learn-network__badge--security">
        <span>Security</span>
        <strong>Finality and resilience</strong>
      </div>

      <div className="learn-network__badge learn-network__badge--peer">
        <span>Peer-to-peer</span>
        <strong>Connected global operators</strong>
      </div>
    </div>
  );
}
