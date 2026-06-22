import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from './AuthProvider';
import Matter from 'matter-js';

export const AccountTab: React.FC = () => {
  const { profile, isAuthenticated, loading } = useAuth();
  
  const [isZeroGravity, setIsZeroGravity] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Hidden Easter Egg Trigger: click username 5 times rapidly
  const handleUsernameClick = () => {
    if (isZeroGravity) return;

    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }

    setClickCount((prev) => {
      const next = prev + 1;
      if (next >= 5) {
        setIsZeroGravity(true);
        return 0;
      }
      return next;
    });

    clickTimeoutRef.current = setTimeout(() => {
      setClickCount(0);
    }, 2000);
  };

  const handleManageBilling = () => {
    if (typeof window !== 'undefined') {
      window.open('/account/billing', '_blank');
    }
  };

  // Physics simulation engine hook
  useEffect(() => {
    if (!isZeroGravity || !containerRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 300;
    const height = rect.height || 500;

    const { Engine, World, Bodies, Mouse, MouseConstraint, Runner } = Matter;

    // Create physics engine
    const engine = Engine.create();
    engine.gravity.y = -0.5; // Antigravity: float upwards

    // Boundary walls (static bodies)
    const thickness = 60;
    const ceiling = Bodies.rectangle(width / 2, -thickness / 2, width, thickness, { isStatic: true });
    const floor = Bodies.rectangle(width / 2, height + thickness / 2, width, thickness, { isStatic: true });
    const leftWall = Bodies.rectangle(-thickness / 2, height / 2, thickness, height, { isStatic: true });
    const rightWall = Bodies.rectangle(width + thickness / 2, height / 2, thickness, height, { isStatic: true });

    World.add(engine.world, [ceiling, floor, leftWall, rightWall]);

    // Find and map DOM elements to physics bodies
    const targets = container.querySelectorAll('.physics-body');
    const bodiesMap: Array<{ body: any; el: HTMLElement; initialX: number; initialY: number }> = [];

    targets.forEach((el: any) => {
      const elRect = el.getBoundingClientRect();
      const parentRect = container.getBoundingClientRect();

      // Relative coordinates
      const x = elRect.left - parentRect.left + elRect.width / 2;
      const y = elRect.top - parentRect.top + elRect.height / 2;
      const w = elRect.width || 80;
      const h = elRect.height || 24;

      const body = Bodies.rectangle(x, y, w, h, {
        restitution: 0.6,
        frictionAir: 0.08,
      });

      bodiesMap.push({
        body,
        el,
        initialX: x,
        initialY: y,
      });

      World.add(engine.world, body);

      // Make element position absolute/relative to support transformations
      el.style.position = 'relative';
      el.style.zIndex = '10';
      el.style.display = 'inline-block';
    });

    // Add mouse constraint to throw things around
    const mouse = Mouse.create(container);
    // Remove mouse scroll listeners to avoid viewport hijacking
    mouse.element.removeEventListener('mousewheel', (mouse as any).mousewheel);
    mouse.element.removeEventListener('DOMMouseScroll', (mouse as any).mousewheel);

    const mouseConstraint = MouseConstraint.create(engine, {
      mouse: mouse,
      constraint: {
        stiffness: 0.1,
        render: { visible: false }
      }
    });

    World.add(engine.world, mouseConstraint);

    // Run the engine
    const runner = Runner.create();
    Runner.run(runner, engine);

    // Sync loop: map physics positions to CSS transforms
    let animId: number;
    const sync = () => {
      bodiesMap.forEach(({ body, el, initialX, initialY }) => {
        const dx = body.position.x - initialX;
        const dy = body.position.y - initialY;
        el.style.transform = `translate(${dx}px, ${dy}px) rotate(${body.angle}rad)`;
      });
      animId = requestAnimationFrame(sync);
    };
    animId = requestAnimationFrame(sync);

    // Cleanup physics on reset
    return () => {
      cancelAnimationFrame(animId);
      Runner.stop(runner);
      World.clear(engine.world, false);
      Engine.clear(engine);

      // Reset DOM transforms
      bodiesMap.forEach(({ el }) => {
        el.style.transform = '';
        el.style.position = '';
        el.style.zIndex = '';
        el.style.display = '';
      });
    };
  }, [isZeroGravity]);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.monoText}>LOADING PROFILE...</div>
      </div>
    );
  }

  if (!isAuthenticated || !profile) {
    return (
      <div style={styles.container}>
        <div style={styles.label}>ACCOUNT</div>
        <div style={styles.monoText}>Not connected. Please connect your GitHub account.</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={styles.container}>
      <div className="physics-body" style={styles.label}>ACCOUNT</div>
      
      {/* Decorative square "Robotic Eyes" */}
      <div style={styles.eyesContainer}>
        <div className="physics-body" style={styles.eye}>[ █ ]</div>
        <div className="physics-body" style={styles.eye}>[ █ ]</div>
      </div>

      {/* Read-Only Profile Card */}
      <div style={styles.profileCard}>
        <div 
          onClick={handleUsernameClick}
          className="physics-body"
          style={{ ...styles.username, cursor: isZeroGravity ? 'grab' : 'pointer' }}
          title={isZeroGravity ? 'Grab me!' : 'Click 5x rapidly for a surprise'}
        >
          @{profile.github_username || profile.github_id || 'github_user'}
        </div>
        <div className="physics-body" style={styles.tierInfo}>
          Current Plan: <span style={styles.tierBadge}>{profile.tier}</span>
        </div>
        
        {profile.tier === 'MAX' && (
          <div className="physics-body" style={styles.creditsSection}>
            Remaining API Credits: <span style={styles.creditsVal}>{profile.api_credits_remaining}/100</span>
          </div>
        )}
      </div>

      <div style={styles.btnColumn}>
        <button onClick={handleManageBilling} style={styles.primaryBtn}>
          [ MANAGE BILLING / UPGRADE ]
        </button>

        {isZeroGravity && (
          <button onClick={() => setIsZeroGravity(false)} style={styles.resetBtn}>
            [ RESTORE GRAVITY ]
          </button>
        )}
      </div>
    </div>
  );
};

// Brutalist Style Tokens (flat, borders, monospace)
const styles = {
  container: {
    padding: '16px',
    backgroundColor: '#000000',
    color: '#ffffff',
    fontFamily: '"JetBrains Mono", "SF Mono", Monaco, Consolas, monospace',
    position: 'relative' as const,
    overflow: 'hidden' as const,
    minHeight: '400px',
  },
  label: {
    fontSize: '10px',
    letterSpacing: '0.12em',
    color: '#888888',
    marginBottom: '16px',
    fontWeight: 'bold' as const,
    display: 'block',
  },
  monoText: {
    fontSize: '12px',
    color: '#888888',
  },
  eyesContainer: {
    display: 'flex',
    justifyContent: 'center',
    gap: '16px',
    marginBottom: '20px',
  },
  eye: {
    fontSize: '24px',
    color: '#38E54D', // Green
    userSelect: 'none' as const,
  },
  profileCard: {
    border: '1px solid rgba(255, 255, 255, 0.12)',
    padding: '16px',
    marginBottom: '20px',
    backgroundColor: '#000000',
  },
  username: {
    fontSize: '14px',
    fontWeight: 'bold' as const,
    color: '#ffffff',
    marginBottom: '8px',
    userSelect: 'none' as const,
  },
  tierInfo: {
    fontSize: '12px',
    color: '#888888',
    marginBottom: '12px',
  },
  tierBadge: {
    color: '#1A56DB', // Bold Blue
    fontWeight: 'bold' as const,
  },
  creditsSection: {
    fontSize: '12px',
    color: '#38E54D', // Green
    borderTop: '1px solid rgba(255, 255, 255, 0.12)',
    paddingTop: '8px',
  },
  creditsVal: {
    fontWeight: 'bold' as const,
  },
  btnColumn: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px',
    position: 'relative' as const,
    zIndex: 100, // keep buttons above floating cards
  },
  primaryBtn: {
    backgroundColor: '#1A56DB', // Bold Blue
    color: '#ffffff',
    border: 'none',
    padding: '10px 16px',
    fontFamily: 'inherit',
    fontSize: '12px',
    fontWeight: 'bold' as const,
    cursor: 'pointer',
    textAlign: 'center' as const,
    outline: 'none',
  },
  resetBtn: {
    backgroundColor: '#38E54D', // Green
    color: '#000000',
    border: 'none',
    padding: '10px 16px',
    fontFamily: 'inherit',
    fontSize: '12px',
    fontWeight: 'bold' as const,
    cursor: 'pointer',
    textAlign: 'center' as const,
    outline: 'none',
  },
};
