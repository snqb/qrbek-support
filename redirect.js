const destination = location.pathname.endsWith("/pay.html") ? "/pay.html" : "/";
location.replace(`${destination}${location.hash}`);
