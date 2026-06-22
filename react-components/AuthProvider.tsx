import React, { createContext, useContext, useState, useEffect } from 'react';

export type SubscriptionTier = 'CORE' | 'PRO' | 'MAX';

export interface UserProfile {
  github_id: string;
  github_username: string;
  tier: SubscriptionTier;
  api_credits_remaining: number;
}

interface AuthContextType {
  user: any;
  profile: UserProfile | null;
  loading: boolean;
  refetchProfile: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // VS Code API acquisition
  const getVsCodeApi = () => {
    if (typeof window !== 'undefined' && (window as any).acquireVsCodeApi) {
      if (!(window as any).vscode) {
        (window as any).vscode = (window as any).acquireVsCodeApi();
      }
      return (window as any).vscode;
    }
    return null;
  };

  const refetchProfile = async () => {
    const vscode = getVsCodeApi();
    if (vscode) {
      vscode.postMessage({ type: 'ready' });
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg) return;

      // Handle profile hydration from Extension Host
      if (msg.command === 'HYDRATE_PROFILE') {
        const payload = msg.payload;
        setProfile({
          github_id: payload.githubId || '',
          github_username: payload.githubUsername || '',
          tier: (payload.tier || 'CORE') as SubscriptionTier,
          api_credits_remaining: typeof payload.credits === 'number' ? payload.credits : 0,
        });
        setLoading(false);
      }
      
      // Handle authentication state change
      if (msg.type === 'AUTH_STATE_CHANGE') {
        setIsAuthenticated(Boolean(msg.isAuthenticated));
        if (!msg.isAuthenticated) {
          setProfile(null);
        }
      }
    };

    window.addEventListener('message', handleMessage);

    // Trigger initial state pull by sending 'ready' to Extension Host
    const vscode = getVsCodeApi();
    if (vscode) {
      console.log('REACT: Sent WEBVIEW_READY, waiting for hydration...');
      vscode.postMessage({ command: 'WEBVIEW_READY' });
      vscode.postMessage({ type: 'ready' });
    }

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user: isAuthenticated ? { id: profile?.github_id } : null, profile, loading, refetchProfile, isAuthenticated }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
