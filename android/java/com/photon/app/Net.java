package com.photon.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.io.File;
import java.io.FileOutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** The phone's addresses on the home network. */
final class Net {
    private Net() {}

    static final class Address {
        final String ip;
        final int prefix;
        Address(String ip, int prefix) { this.ip = ip; this.prefix = prefix; }
    }

    static List<Address> addresses(Context c) {
        List<Address> wifi = new ArrayList<>();
        List<Address> other = new ArrayList<>();
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                LinkProperties lp = cm.getLinkProperties(n);
                if (caps == null || lp == null) continue;
                // Mobile data and VPNs aren't the home network.
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
                boolean home = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
                for (LinkAddress la : lp.getLinkAddresses()) {
                    InetAddress a = la.getAddress();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    (home ? wifi : other).add(new Address(a.getHostAddress(), la.getPrefixLength()));
                }
            }
        } catch (RuntimeException ignored) {
            // Fall through to the plain Java list below.
        }
        if (wifi.isEmpty() && other.isEmpty()) {
            try {
                for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback() || ni.getName().startsWith("rmnet")) continue;
                    for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                        InetAddress a = ia.getAddress();
                        if (a instanceof Inet4Address && !a.isLinkLocalAddress()) {
                            other.add(new Address(a.getHostAddress(), ia.getNetworkPrefixLength()));
                        }
                    }
                }
            } catch (Exception ignored) {
                // No addresses we can see.
            }
        }
        wifi.addAll(other);
        return wifi;
    }

    /** The address other devices at home should use, or null when the phone isn't on Wi-Fi. */
    static String homeUrl(Context c) {
        List<Address> list = addresses(c);
        return list.isEmpty() ? null : "http://" + list.get(0).ip + ":" + Photon.PORT;
    }

    /** Writes the addresses where android-main.js can read them. */
    static void write(Context c, File file) {
        StringBuilder sb = new StringBuilder("{\"addresses\":[");
        List<Address> list = addresses(c);
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"address\":\"").append(list.get(i).ip).append("\",\"prefix\":").append(list.get(i).prefix).append('}');
        }
        sb.append("]}");
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(sb.toString().getBytes("UTF-8"));
        } catch (Exception e) {
            return;
        }
        tmp.renameTo(file);
    }
}
